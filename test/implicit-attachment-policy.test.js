import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveThreadAttachments } from "../packages/core/src/thread-attachments.js";

test("all prose URI forms reject credential fixtures before materialization, including aliases",async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"orkestr-sensitive-uri-"));
  const workspace=path.join(home,"workspace");await fs.mkdir(workspace);
  const sensitive=path.join(workspace,".env.production"),alias=path.join(workspace,"report.txt"),safe=path.join(workspace,"safe.txt");
  await fs.writeFile(sensitive,"SYNTHETIC_TEST_VALUE=fixture");await fs.writeFile(safe,"ordinary report");await fs.symlink(sensitive,alias);
  const thread={id:"fixture-thread",ownerUserId:"fixture-owner",cwd:workspace,workspace},env={ORKESTR_HOME:home};
  for(const target of [sensitive,alias]) {
    for(const uri of [target,`sandbox:${target}`,`file://${target}`,`sandbox:${target.replace('.env','%2Eenv')}`]) {
      for(const text of [`Reviewed ${uri}`,`Reviewed [file](${uri})`]) {
        const result=await resolveThreadAttachments({thread,text,env});
        assert.equal(result.attachments.length,0,`${uri} must not become an attachment`);
        assert.ok(result.skipped.some(x=>x.reason==="attachment_requires_explicit_selection"));
        assert.equal(result.artifactOutcomes.some(x=>["materialized","reused"].includes(x.status)),false);
      }
    }
  }
  await assert.rejects(fs.access(path.join(home,"uploads",thread.id,"artifacts")));
  assert.equal((await resolveThreadAttachments({thread,text:`[report](sandbox:${safe})`,env})).attachments.length,1);
  assert.equal((await resolveThreadAttachments({thread,attachments:[{path:sensitive}],env})).attachments.length,1,"explicit selection still uses canonical owner/path policy");
});
