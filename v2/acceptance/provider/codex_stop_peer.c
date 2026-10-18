/* Deliberately synthetic native stream. No credentials, inference or network. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifndef ACK_ONLY
#define ACK_ONLY 0
#endif
static void trace(const char *kind) {
 FILE *f=fopen("synthetic-native-trace.jsonl","a"); if(!f)exit(2);
 fprintf(f,"{\"kind\":\"%s\",\"pid\":%ld}\n",kind,(long)getpid());fclose(f);
}
int main(void) {
 char line[65536],cwd[4096];int turns=0,interrupts=0;
 if(!getcwd(cwd,sizeof(cwd)))return 2;
 trace("spawn");
 while(fgets(line,sizeof(line),stdin)) {
  char *key=strstr(line,"\"id\":");long id=key?strtol(key+5,0,10):0;
  if(strstr(line,"\"initialize\"")) {
   printf("{\"id\":%ld,\"result\":{\"userAgent\":\"synthetic-stop\",\"platformFamily\":\"unix\",\"platformOs\":\"linux\",\"codexHome\":\"synthetic\"}}\n",id);
  } else if(strstr(line,"\"initialized\""))continue;
  else if(strstr(line,"\"account/read\"")) {
   printf("{\"id\":%ld,\"result\":{\"requiresOpenaiAuth\":true,\"account\":{\"type\":\"chatgpt\"}}}\n",id);
  } else if(strstr(line,"\"thread/start\"")) {
   printf("{\"id\":%ld,\"result\":{\"modelProvider\":\"openai\",\"cwd\":\"%s\",\"thread\":{\"modelProvider\":\"openai\",\"id\":\"synthetic-stop-session\",\"ephemeral\":false,\"cwd\":\"%s\"},\"approvalPolicy\":\"never\",\"sandbox\":{\"type\":\"readOnly\"}}}\n",id,cwd,cwd);
  } else if(strstr(line,"\"turn/start\"")) {
   if(++turns!=1)return 2;
   trace("turn");
   printf("{\"id\":%ld,\"result\":{\"turn\":{\"id\":\"synthetic-stop-turn\",\"status\":\"inProgress\"}}}\n",id);
   printf("{\"method\":\"turn/started\",\"params\":{\"threadId\":\"synthetic-stop-session\",\"turn\":{\"id\":\"synthetic-stop-turn\",\"status\":\"inProgress\"}}}\n");
   printf("{\"method\":\"item/agentMessage/delta\",\"params\":{\"threadId\":\"synthetic-stop-session\",\"turnId\":\"synthetic-stop-turn\",\"delta\":\"1\\n2\\n\"}}\n");
  } else if(strstr(line,"\"turn/interrupt\"")) {
   if(++interrupts!=1||turns!=1)return 2;
   trace("interrupt");
   printf("{\"id\":%ld,\"result\":{}}\n",id);
   if(!ACK_ONLY)printf("{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"synthetic-stop-session\",\"turn\":{\"id\":\"synthetic-stop-turn\",\"status\":\"interrupted\"}}}\n");
  } else return 2;
  fflush(stdout);
 }
 return 0;
}
