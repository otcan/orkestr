//! Trusted containment bridge. Freshness is not a consumed inference capability.
use super::*;
impl Store {
    /// Serialize a bounded synchronous enqueue/flush/spawn action against durable
    /// fencing. Caller MUST separately consume a ConsumedProviderDispatch for
    /// inference. No provider wait, blocking pipe, network call or async callback
    /// is allowed here. The containment transport uses bounded nonblocking I/O.
    ///
    /// Multithread Tokio callers leave the worker via block_in_place; a current-
    /// thread runtime fails closed. Outside Tokio a short-lived runtime drives
    /// SQLite only. Never substitutes a process-local mutex for durable fencing.
    pub fn with_execution_fence<T, E>(
        &self,
        admission: &ProviderAdmission,
        action: impl FnOnce() -> std::result::Result<T, E>,
    ) -> Result<std::result::Result<T, E>> {
        self.with_purpose_fence(admission, AdmissionPurpose::Execution, action)
    }
    /// Bounded nonblocking interrupt transport only. This never grants execution
    /// or confirms a stop: only the exact issued control token is usable here.
    pub fn with_cancellation_fence<T, E>(
        &self,
        admission: &ProviderAdmission,
        action: impl FnOnce() -> std::result::Result<T, E>,
    ) -> Result<std::result::Result<T, E>> {
        self.with_purpose_fence(
            admission,
            AdmissionPurpose::CancellationAcknowledgement,
            action,
        )
    }
    fn with_purpose_fence<T, E>(
        &self,
        admission: &ProviderAdmission,
        purpose: AdmissionPurpose,
        action: impl FnOnce() -> std::result::Result<T, E>,
    ) -> Result<std::result::Result<T, E>> {
        let operation = async {
            let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
            let row = self.production_authorized_run(&mut tx, admission).await?;
            if admission.run.purpose != purpose
                || match purpose {
                    AdmissionPurpose::Execution => {
                        !matches!(row.get::<&str, _>("state"), "starting" | "running")
                    }
                    AdmissionPurpose::CancellationAcknowledgement => {
                        row.get::<&str, _>("state") != "cancel_requested"
                    }
                }
                || row.get::<&str, _>("dispatch_state") != "delivery_unknown"
            {
                return Err(RuntimeStoreError::Fenced);
            }
            let result = action();
            // This transaction makes no durable change. Once action ran, a
            // failed COMMIT cannot justify retrying inference or granting a token.
            tx.commit().await.map_err(db)?;
            Ok(result)
        };
        match tokio::runtime::Handle::try_current() {
            Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
                tokio::task::block_in_place(|| handle.block_on(operation))
            }
            Ok(_) => Err(RuntimeStoreError::Unavailable),
            Err(_) => tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(db)?
                .block_on(operation),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::production_runtime::tests::{claim, ready, setup};
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn only_consumed_current_authority_invokes_action() {
        let f = setup().await;
        let b = ready(&f).await;
        let claim = claim(&f, &b).await;
        let run = f
            .handle
            .admit_run(&claim, &b.session_id, b.generation, "fence-run")
            .await
            .unwrap();
        let mut calls = 0;
        let refused = f.handle.with_execution_fence(&run.provider, || {
            calls += 1;
            Ok::<_, ()>(())
        });
        assert!(matches!(refused, Err(RuntimeStoreError::Fenced)));
        assert_eq!(calls, 0);
        let DispatchClaimResult::Reserved(reservation) = f
            .handle
            .claim_provider_dispatch(&run, "fence-reserve")
            .await
            .unwrap()
        else {
            panic!()
        };
        let ExecutionConsumption::Dispatch(cap) =
            f.handle.consume_execution(&reservation).await.unwrap()
        else {
            panic!()
        };
        assert_eq!(
            f.handle
                .with_execution_fence(cap.provider(), || {
                    calls += 1;
                    Ok::<_, ()>(7)
                })
                .unwrap(),
            Ok(7)
        );
        let mut forged = cap.provider().clone();
        forged.run.dispatch_fence += 1;
        assert!(matches!(
            f.handle.with_execution_fence(&forged, || {
                calls += 1;
                Ok::<_, ()>(())
            }),
            Err(RuntimeStoreError::Fenced)
        ));
        f.store.revoke_session(&f.token).await.unwrap();
        assert!(matches!(
            f.handle.with_execution_fence(cap.provider(), || {
                calls += 1;
                Ok::<_, ()>(())
            }),
            Err(RuntimeStoreError::Unauthorized)
        ));
        assert_eq!(calls, 1);
    }
}
