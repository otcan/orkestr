//! Trusted, unregistered automatic-reply transport. No route/account selection.
//!
//! The caller transfers a privately configured, exclusively owned connected
//! socket. It must not retain duplicate writers or put a second deferred sender
//! behind this boundary. This leaf proves local socket bytes, never external ACK.
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::AutomaticReplySendReceipt;
use orkestr_v2_store_sqlite::{
    AutomaticReplyConsumption, AutomaticReplyDelivery, AutomaticReplyProducer,
    AutomaticReplyReservationResult, Store,
};
use std::{io, io::Write, net::Shutdown, os::unix::net::UnixStream};
use uuid::Uuid;

/// Exact trusted ingress identity and frozen output; Core copies/hashes bytes.
pub struct FrozenReply<'a> {
    pub input_id: Uuid,
    pub request_key: &'a str,
    pub output: &'a [u8],
}

#[derive(Debug)]
pub enum TransportFailure {
    Store(RuntimeStoreError),
    Socket(io::Error),
    Closed,
}

pub enum ReplyStart {
    Writing(ReplyWrite),
    Replay(AutomaticReplySendReceipt),
    ReconciliationRequired,
}

#[derive(Debug, PartialEq, Eq)]
pub enum WriteProgress {
    /// Total local offset; an unchanged offset means known nonblocking WouldBlock.
    Pending {
        written_bytes: usize,
    },
    ReadyToFinish,
}

/// Non-Clone local writer. No socket, credential or capability getter.
pub struct ReplyWrite {
    store: Store,
    credential: String,
    socket: Option<UnixStream>,
    delivery: Option<AutomaticReplyDelivery>,
}

/// Reserve/consume once, with no transport bytes until the returned writer steps.
/// Replay/reconciliation/error closes the transferred socket without any write.
pub async fn reserve_and_consume(
    store: &Store,
    credential: &str,
    producer: &AutomaticReplyProducer,
    reply: FrozenReply<'_>,
    socket: UnixStream,
) -> Result<ReplyStart, TransportFailure> {
    // Own cleanup even across an async cancellation or pre-consume failure.
    let mut writer = ReplyWrite {
        store: store.clone(),
        credential: credential.to_owned(),
        socket: Some(socket),
        delivery: None,
    };
    writer
        .socket
        .as_ref()
        .unwrap()
        .set_nonblocking(true)
        .map_err(TransportFailure::Socket)?;
    let reservation = match store
        .reserve_automatic_reply(
            credential,
            producer,
            reply.input_id,
            reply.request_key,
            reply.output,
        )
        .await
        .map_err(TransportFailure::Store)?
    {
        AutomaticReplyReservationResult::Reserved(reservation) => reservation,
        AutomaticReplyReservationResult::Replay(receipt) => return Ok(ReplyStart::Replay(receipt)),
    };
    match store
        .consume_automatic_reply(credential, reservation)
        .await
        .map_err(TransportFailure::Store)?
    {
        AutomaticReplyConsumption::Deliver(delivery) => {
            writer.delivery = Some(delivery);
            Ok(ReplyStart::Writing(writer))
        }
        AutomaticReplyConsumption::ReconciliationRequired => Ok(ReplyStart::ReconciliationRequired),
    }
}

impl ReplyWrite {
    /// Exactly one bounded actual nonblocking socket write under the Core fence.
    /// All errors are terminal: discard capability and shutdown the owned socket.
    pub fn step(&mut self, max_bytes: usize) -> Result<WriteProgress, TransportFailure> {
        let result = self.step_inner(max_bytes);
        if result.is_err() {
            self.close();
        }
        result
    }

    fn step_inner(&mut self, max_bytes: usize) -> Result<WriteProgress, TransportFailure> {
        if !(1..=16384).contains(&max_bytes) {
            return Err(TransportFailure::Store(RuntimeStoreError::InvalidInput));
        }
        let delivery = self.delivery.as_mut().ok_or(TransportFailure::Closed)?;
        let offset = delivery.written_bytes();
        let remaining = delivery.receipt().byte_length as usize - offset;
        if remaining == 0 {
            return Ok(WriteProgress::ReadyToFinish);
        }
        let socket = self.socket.as_mut().ok_or(TransportFailure::Closed)?;
        self.store
            .with_automatic_reply_fence(
                &self.credential,
                delivery,
                offset,
                remaining.min(max_bytes),
                |bytes| match socket.write(bytes) {
                    Ok(0) => Err(io::Error::from(io::ErrorKind::WriteZero)),
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok(0),
                    result => result,
                },
            )
            .map_err(TransportFailure::Store)?
            .map_err(TransportFailure::Socket)?;
        Ok(
            if delivery.written_bytes() == delivery.receipt().byte_length as usize {
                WriteProgress::ReadyToFinish
            } else {
                WriteProgress::Pending {
                    written_bytes: delivery.written_bytes(),
                }
            },
        )
    }

    /// Consumes the writer. A full local write still returns delivery_unknown.
    /// No external sent/ACK claim or fresh write authority is created.
    pub async fn finish(mut self) -> Result<AutomaticReplySendReceipt, TransportFailure> {
        let delivery = self.delivery.take().ok_or(TransportFailure::Closed)?;
        self.store
            .finish_automatic_reply_write(&self.credential, delivery)
            .await
            .map_err(TransportFailure::Store)
    }

    fn close(&mut self) {
        self.delivery.take();
        if let Some(socket) = self.socket.take() {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
}

impl Drop for ReplyWrite {
    fn drop(&mut self) {
        self.close();
    }
}
