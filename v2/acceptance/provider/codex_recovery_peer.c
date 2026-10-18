/* Fixed synthetic protocol peer. No credentials, inference, tools or network.
 * Namespace PIDs in the private trace are labels, never host process authority. */
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <unistd.h>

static int step;
static char token[32];
static void trace(const char *kind, int resumed) {
 FILE *file=fopen("synthetic-recovery-trace.jsonl","a"); if(!file)exit(2);
 fprintf(file,"{\"kind\":\"%s\",\"step\":%d,\"resumed\":%d,\"namespace_pid\":%ld}\n",
         kind,step,resumed,(long)getpid());
 if(fclose(file))exit(2);
}
static void load(void) {
 FILE *file=fopen("synthetic-recovery-state","r");
 if(!file) { if(errno!=ENOENT)exit(2); return; }
 if(fscanf(file,"%d %31s",&step,token)<1||step<1||step>3)exit(2);
 if(fclose(file))exit(2);
}
static void save(void) {
 FILE *file=fopen("synthetic-recovery-state","w"); if(!file)exit(2);
 if(fprintf(file,"%d %s\n",step,token)<0||fclose(file))exit(2);
}
static void extract(const char *line, const char *prefix, size_t digits, char *out) {
 const char *value=strstr(line,prefix); size_t size=strlen(prefix);
 if(!value||strlen(value)<size+digits)exit(2);
 for(size_t i=0;i<digits;i++)if(!isxdigit((unsigned char)value[size+i]))exit(2);
 if(isxdigit((unsigned char)value[size+digits]))exit(2);
 memcpy(out,value,size+digits); out[size+digits]=0;
}
int main(void) {
 char line[65536],cwd[4096]; int turns=0,interrupts=0,ready=0,resumed=0;
 int lock=open("synthetic-recovery-lock",O_CREAT|O_RDWR|O_CLOEXEC,0600);
 if(lock<0||flock(lock,LOCK_EX|LOCK_NB)||!getcwd(cwd,sizeof(cwd)))return 2;
 /* Acceptance creates only canonical ASCII temporary paths. */
 if(strpbrk(cwd,"\"\\\n\r"))return 2;
 load(); trace("spawn",0);
 while(fgets(line,sizeof(line),stdin)) {
  if(!strchr(line,'\n'))return 2;
  if(strstr(line,"\"initialized\""))continue;
  char *key=strstr(line,"\"id\":"); long id=key?strtol(key+5,0,10):0;
  if(id<=0)return 2;
  if(strstr(line,"\"initialize\"")) {
   printf("{\"id\":%ld,\"result\":{\"userAgent\":\"synthetic-recovery\",\"platformFamily\":\"unix\",\"platformOs\":\"linux\",\"codexHome\":\"synthetic\"}}\n",id);
  } else if(strstr(line,"\"account/read\"")) {
   printf("{\"id\":%ld,\"result\":{\"requiresOpenaiAuth\":true,\"account\":{\"type\":\"chatgpt\"}}}\n",id);
  } else if(strstr(line,"\"thread/start\"")||strstr(line,"\"thread/resume\"")) {
   resumed=strstr(line,"\"thread/resume\"")!=NULL;
   if(ready++||(!resumed&&step)||(resumed&&(!step||!strstr(line,"synthetic-recovery-session"))))return 2;
   trace("ready",resumed);
   printf("{\"id\":%ld,\"result\":{\"modelProvider\":\"openai\",\"cwd\":\"%s\",\"thread\":{\"modelProvider\":\"openai\",\"id\":\"synthetic-recovery-session\",\"ephemeral\":false,\"cwd\":\"%s\"},\"approvalPolicy\":\"never\",\"sandbox\":{\"type\":\"readOnly\"}}}\n",id,cwd,cwd);
  } else if(strstr(line,"\"turn/start\"")) {
   if(++turns!=1||!ready||!strstr(line,"synthetic-recovery-session"))return 2;
   if(strstr(line,"HELD_INPUT_MUST_NOT_EXECUTE")) { trace("rejected-held",resumed); return 2; }
   char output[80]={0};
   if(step==0) {
    if(!strstr(line,"integers 1 through 1000"))return 2;
    strcpy(output,"1\\n2\\n");
   } else if(step==1) {
    extract(line,"RECOVERY_",12,token); strcpy(output,token);
   } else if(step==2) {
    char suffix[32]; extract(line,"RESTART_",8,suffix);
    if(!*token)return 2;
    snprintf(output,sizeof(output),"%s %s",token,suffix);
   } else return 2;
   step++; save(); trace("turn",resumed);
   printf("{\"id\":%ld,\"result\":{\"turn\":{\"id\":\"synthetic-recovery-turn-%d\",\"status\":\"inProgress\"}}}\n",id,step);
   printf("{\"method\":\"turn/started\",\"params\":{\"threadId\":\"synthetic-recovery-session\",\"turn\":{\"id\":\"synthetic-recovery-turn-%d\",\"status\":\"inProgress\"}}}\n",step);
   printf("{\"method\":\"item/agentMessage/delta\",\"params\":{\"threadId\":\"synthetic-recovery-session\",\"turnId\":\"synthetic-recovery-turn-%d\",\"delta\":\"%s\"}}\n",step,output);
   if(step>1)printf("{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"synthetic-recovery-session\",\"turn\":{\"id\":\"synthetic-recovery-turn-%d\",\"status\":\"completed\"}}}\n",step);
  } else if(strstr(line,"\"turn/interrupt\"")) {
   if(++interrupts!=1||turns!=1||step!=1)return 2;
   trace("interrupt",resumed);
   printf("{\"id\":%ld,\"result\":{}}\n",id);
   printf("{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"synthetic-recovery-session\",\"turn\":{\"id\":\"synthetic-recovery-turn-1\",\"status\":\"interrupted\"}}}\n");
  } else return 2;
  if(fflush(stdout))return 2;
 }
 close(lock);
 return ferror(stdin)?2:0;
}
