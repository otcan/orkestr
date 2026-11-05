/* Included only by the opt-in synthetic native. No provider/network calls. */
static void workspace_tools(void) {
    char command[4096], response[16386], job[37] = {0}, arguments[8192];
    read_fixed("workspace-command", command, sizeof(command));
    for (const char *p = command; *p; ++p)
        if (!strchr("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/_-. ", *p)) exit(70);
    for (int action = 0; action < 5; ++action) {
        if (action == 0) snprintf(arguments, sizeof(arguments), "{\"command\":\"%s\"}", command);
        else if (action == 1 || action == 2) strcpy(arguments, "{\"command\":\"/usr/bin/sleep 120\",\"background\":true}");
        else snprintf(arguments, sizeof(arguments), "{\"job\":\"%s\",\"action\":\"%s\"}", job, action==3?"status":"cancel");
        printf("{\"id\":\"workspace:%d\",\"method\":\"item/tool/call\",\"params\":{"
            "\"threadId\":\"%s\",\"turnId\":\"%s\",\"callId\":\"workspace:%d\","
            "\"tool\":\"orkestr_workspace_exec\",\"arguments\":%s}}\n",action,native,turn,action,arguments);
        fflush(stdout);
        if (!fgets(response,sizeof(response),stdin) || !strchr(response,'\n') || strstr(response,"\"method\"")) exit(71);
        const char *success=value(response,"\"success\"");
        int refused = action==2 || action==4;
        if (!success || strncmp(success,refused?"false":"true",refused?5:4)) exit(72);
        if (action==0 && !strstr(response,"managed workspace proof")) exit(73);
        if (action==1) {
            const char *text=strstr(response,"job=");if(!text || strlen(text+4)<36)exit(74);
            memcpy(job,text+4,36);job[36]=0;
            for(int i=0;i<36;++i)if(!strchr("0123456789abcdef-",job[i]))exit(75);
        }
        if (action==2 && !strstr(response,"job refused")) exit(79);
        if (action==3 && !strstr(response,"state=running")) exit(76);
        if (action==4 && !strstr(response,"state=cancelled")) exit(77);
        FILE *receipt=fopen("/account/sessions/synthetic-workspace-results.jsonl","a");
        if(!receipt || fputs(response,receipt)==EOF || fclose(receipt))exit(78);
    }
}
