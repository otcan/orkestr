// Synthetic UI state only. Real Core/scheduler/filesystem acceptance is separate.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export function trackerState(conversation) {
  return {conversation,enabled:false,source:null,revision:0,sourceDecisions:{},checks:{},reports:[],rows:[],posts:[],loseCheck:true,
    automation:{revision:0,enabled:false,source_current:false,timer_revision:null,authority:null,calendar:null},automationDecisions:{}};
}
const authority = (t,n) => ({authority_id:id(n),namespace:id(n+1),generation:1,conversation_id:t.conversation,source_revision:t.revision,recipe_id:'job-tracker',classifier_digest:'ab'.repeat(32),duplicate:false});
export function completeTrackerCheck(t,key) {
  const check=t.checks[key];
  const result={id:id(30),request_key:'scan:synthetic',namespace:check.authority.namespace,generation:1,due_ms:1,
    source_revision:1,recipe_id:'job-tracker',classifier_digest:'ab'.repeat(32),news:true,digest_id:id(31),labelled:1,dropped:0,duplicates:0,more_mail:true,
    changes:[{kind:'created',row_id:id(40),company:'Example Works',role:'Backend Engineer',event:'applied',from:null,to:'applied',notify:true}],recorded_ms:Date.now(),duplicate:false};
  check.result=result;t.reports=[result];
  t.rows=[{id:id(40),company:'Example Works',company_key:'example works',role:'Backend Engineer',role_key:'backend engineer',source:'direct',status:'applied',
    status_changed_ms:Date.now(),applied_ms:Date.now(),last_contact_ms:Date.now(),next_step:'Follow up if no reply',link:'https://example.invalid/job',location:null,
    notes:'',confidence:90,needs_review:false,archived:false,events_count:1,revision:1}];
}
export async function trackerApi(state,req,res,url,{json,body}) {
  const match=/^\/api\/v2\/conversations\/([0-9a-f-]{36})\/tracker(.*)$/.exec(url.pathname);
  if(!match)return false;
  state.trackers??={};const t=state.trackers[match[1]]??=trackerState(match[1]);const suffix=match[2];
  const reply=(status,value)=>{json(res,status,value);return true;};
  if(req.method!=='GET' && req.headers['x-orkestr-csrf']!=='synthetic-csrf')return reply(403,{message:'CSRF required'});
  const input=req.method==='GET'?null:JSON.parse((await body(req))||'null');
  if(input)t.posts.push({method:req.method,suffix,body:structuredClone(input)});
  if(suffix==='' && req.method==='PUT'){t.enabled=true;return reply(200,{});}
  if(!t.enabled)return reply(409,{code:'tracker_not_enabled',message:'Not enabled'});
  if(suffix==='' && req.method==='GET')return reply(200,{conversation_id:t.conversation,recipe:'job-tracker',grant_issued:false,last_scan_ms:null,rows:t.rows,backlog:{pending:0,expired:0,evicted:0,overflow:0,full:false}});
  if(suffix==='/mail-status')return reply(200,{recipe:'job-tracker',source_revision:t.revision,source:t.source,checks:Object.values(t.checks).filter(c=>!c.cancelled&&!c.result),
    scheduler_ready:true,local_mail_supported:true,classifier_id:'synthetic-rules',classifier_digest:'ab'.repeat(32),reader:{occupied:0,cancelled:0},alerts:[]});
  if(suffix==='/mail-sources')return reply(200,{sources:[{id:id(1),label:'Example mail',ready:true,inbox:[{id:id(2),label:'Inbox'}],sent:[{id:id(3),label:'Sent'}]}],expires_ms:Date.now()+600000,read_only:true});
  if(suffix==='/mail-source' && req.method==='PUT'){
    if(t.sourceDecisions[input.request_key])return reply(200,{...t.sourceDecisions[input.request_key],duplicate:true});
    if(input.expected_revision!==t.revision)return reply(409,{message:'Selection changed'});
    t.source=input.source;t.revision++;
    const result={request_key:input.request_key,source_revision:t.revision,source_digest:'cd'.repeat(32),duplicate:false};t.sourceDecisions[input.request_key]=result;return reply(200,result);
  }
  if(suffix.startsWith('/mail-source/decisions/'))return reply(t.sourceDecisions[suffix.split('/').at(-1)]?200:404,t.sourceDecisions[suffix.split('/').at(-1)]??{});
  if(suffix==='/check'){
    let result=t.checks[input.request_key];
    if(!result){result={request_key:input.request_key,authority:authority(t,10),cancelled:false,duplicate:false,result:null};t.checks[input.request_key]=result;}
    if(t.loseCheck){t.loseCheck=false;return reply(503,{message:'Response interrupted. Check the saved change.'});}
    return reply(200,{...result,duplicate:true});
  }
  if(suffix.startsWith('/checks/')){
    const key=suffix.split('/').at(-1);const check=t.checks[key];
    if(req.method==='DELETE'){
      const result=check??{request_key:key,authority:null,result:null};result.cancelled=true;result.duplicate=false;t.checks[key]=result;return reply(200,result);
    }
    return reply(check?200:404,check??{});
  }
  if(suffix==='/scan-reports')return reply(200,t.reports);
  if(suffix==='/automation' && req.method==='GET')return reply(200,t.automation);
  if(suffix==='/automation'){
    if(t.automationDecisions[input.request_key])return reply(200,{...t.automationDecisions[input.request_key],duplicate:true});
    if(input.expected_revision!==t.automation.revision)return reply(409,{message:'Schedule changed'});
    const enabled=req.method==='POST';
    t.automation={revision:t.automation.revision+1,enabled,source_current:true,timer_revision:enabled?2:3,authority:enabled?authority(t,20):t.automation.authority,calendar:input.calendar??t.automation.calendar};
    const result={request_key:input.request_key,revision:t.automation.revision,enabled,authority:t.automation.authority,duplicate:false};t.automationDecisions[input.request_key]=result;return reply(200,result);
  }
  if(suffix.startsWith('/automation/decisions/'))return reply(t.automationDecisions[suffix.split('/').at(-1)]?200:404,t.automationDecisions[suffix.split('/').at(-1)]??{});
  return reply(404,{message:'Synthetic tracker route missing'});
}
