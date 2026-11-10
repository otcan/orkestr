//! Provider sign-in control. Reply fields are checked closed by the HTTP layer.
use super::*;
use orkestr_v2_contracts::SignInProvider;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInCommand {
    Status,
    Start(SignInProvider),
    Code(SignInProvider, String),
    Cancel(SignInProvider),
    SignOut(SignInProvider),
}

impl ManagerClient {
    /// One no-retry control exchange. The reply never carries a credential.
    pub async fn provider_sign_in(
        &self,
        command: SignInCommand,
        deadline: Instant,
    ) -> Result<Value> {
        let (operation, provider) = match &command {
            SignInCommand::Status => ("provider_login_status", None),
            SignInCommand::Start(provider) => ("provider_login_start", Some(*provider)),
            SignInCommand::Code(provider, _) => ("provider_login_code", Some(*provider)),
            SignInCommand::Cancel(provider) => ("provider_login_cancel", Some(*provider)),
            SignInCommand::SignOut(provider) => ("provider_signout", Some(*provider)),
        };
        let mut request = self.request(operation, &format!("sign-in:{}", Uuid::new_v4()), None)?;
        if let Some(provider) = provider {
            request["provider"] = json!(provider.as_str());
        }
        if let SignInCommand::Code(_, code) = command {
            request["code"] = json!(code);
        }
        let (value, _) = self.exchange(request, deadline).await?;
        success_fields(&value, Some("provider_login"))?;
        self.receipt(&value["receipt"])?;
        Ok(value["provider_login"].clone())
    }
}
