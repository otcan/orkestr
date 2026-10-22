// Bridge for attachment_keys_view.rs: enroll this browser's attachment key.
const config=await dioxus.recv();
try{const result=await ageEnsureEnrollment({csrf:config.csrf});await dioxus.send({ok:true,fingerprint:result.fingerprint});}
catch(error){console.warn('Attachment key enrollment failed:',error?.message??error);await dioxus.send({ok:false,message:String(error?.message??error)});}
