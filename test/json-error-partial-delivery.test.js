import assert from "node:assert/strict";
import test from "node:test";
import { JsonErrorFilter } from "../dist/server/apps/server/src/common/json-error.filter.js";

test("Nest error boundary preserves only sanitized partial-delivery evidence",()=>{
  let body,status;
  const response={status(value){status=value;return this;},header(){return this;},type(){return this;},send(value){body=value;}};
  const error=Object.assign(Error("whatsapp_partial_delivery"),{statusCode:409,partialDelivery:{sent:[{id:"ack-1",kind:"text",filename:"private"}],attachments:[{index:0,outcome:"uncertain"}],stage:"send_media",failureCode:"provider_evaluation_failed",cause:"private"}});
  new JsonErrorFilter().catch(error,{switchToHttp:()=>({getRequest:()=>({}),getResponse:()=>response})});
  assert.equal(status,409); assert.equal(body.error,"whatsapp_partial_delivery"); assert.equal(body.retryable,false);
  assert.equal(body.partialDelivery.stage,"send_media"); assert.equal(body.partialDelivery.attachments[0].outcome,"uncertain");
  assert.equal(JSON.stringify(body).includes("private"),false);
});
