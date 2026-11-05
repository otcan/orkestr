/* Fixed ELF Claude stream-json oracle with original-native HTTP MCP. No provider. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#define ORKESTR_MCP_CLAUDE 1

static char native[64], message[64];
static int resumed, read_only;
static void string_value(const char *line, const char *key, char *out, size_t size) {
    const char *p = strstr(line, key);
    if (!p || !(p = strchr(p, ':'))) exit(41);
    while (*++p == ' ' || *p == '\t') {}
    if (*p++ != '"') exit(42);
    size_t n = strcspn(p, "\"");
    if (!n || n >= size) exit(43);
    memcpy(out, p, n); out[n] = 0;
}
static void record(const char *kind, int input, int unused) {
    (void)unused;
    FILE *f = fopen("claude-peer.jsonl", "a");
    if (!f) exit(44);
    fprintf(f, "{\"kind\":\"%s\",\"pid\":%d,\"native\":\"%s\",\"resumed\":%s,"
            "\"read_only\":%s,\"model\":\"%s\",\"effort\":\"%s\",\"number\":%d}\n",
            kind, getpid(), native, resumed ? "true" : "false", read_only ? "true" : "false",
            getenv("ANTHROPIC_MODEL"), getenv("CLAUDE_CODE_EFFORT_LEVEL"), input);
    if (fclose(f)) exit(45);
}
static void mcp_interrupt(const char *line, int input) {
    char id[64]; string_value(line, "\"request_id\"", id, sizeof(id));
    if (!strstr(line, "\"interrupt\"") || !strstr(line, message)) exit(46);
    record("interrupt", input, 0);
    printf("{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"%s\","
           "\"response\":{\"still_queued\":[],\"turn\":\"stopped\"}}}\n", id);
    printf("{\"type\":\"result\",\"uuid\":\"50000000-1111-4222-8333-444444444444\",\"subtype\":\"error_during_execution\",\"is_error\":true,"
           "\"terminal_reason\":\"aborted_streaming\",\"session_id\":\"%s\","
           "\"user_message_uuid\":\"%s\"}\n", native, message);
    fflush(stdout);
}
#include "managed_mcp_native.h"

int main(int argc, char **argv) {
    alarm(330); umask(0077); setvbuf(stdin, NULL, _IONBF, 0);
    /* Reference the shared Codex argv validator without using its protocol. */
    (void)mcp_configuration;
    if (argc < 4 || prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) return 20;
    char cwd[4096];
    if (!getcwd(cwd, sizeof(cwd)) || strcmp(cwd, ORKESTR_TEST_WORKSPACE)) return 30;
    int authority = open(ORKESTR_TEST_AUTHORITY_CORE, O_RDONLY);
    if (authority >= 0) { close(authority); return 31; }
    if (errno != EACCES && errno != ENOENT) return 32;
    strcpy(native, argv[argc - 1]); resumed = !strcmp(argv[argc - 2], "--resume");
    if (!resumed && strcmp(argv[argc - 2], "--session-id")) return 21;
    for (int i = 1; i < argc - 2; ++i) {
        if (!strcmp(argv[i], "--permission-mode")) read_only = 1;
        if (!strcmp(argv[i], "--mcp-config") && i + 1 < argc) {
            const char *p = strstr(argv[i + 1], "http://127.0.0.1:");
            if (p) {
                size_t n = strcspn(p, "\""); if (n >= sizeof(mcp_url)) return 22;
                memcpy(mcp_url, p, n); mcp_url[n] = 0;
            }
        }
    }
    if ((read_only && *mcp_url) || (!read_only && !*mcp_url)) return 23;
    char state[4096]; snprintf(state, sizeof(state), "%s/%s.turns", getenv("CLAUDE_CONFIG_DIR"), native);
    FILE *f = fopen(state, "r"); int turns = 0;
    if ((f != NULL) != resumed) return 24;
    if (f) { if (fscanf(f, "%d", &turns) != 1) return 25; fclose(f); }
    record("spawn", turns, 0);
    char line[65538], id[64];
    if (!fgets(line, sizeof(line), stdin) || !strstr(line, "\"initialize\"")) return 26;
    string_value(line, "\"request_id\"", id, sizeof(id));
    printf("{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"%s\",\"response\":{}}}\n", id);
    fflush(stdout);
    if (!fgets(line, sizeof(line), stdin) || !strstr(line, "\"user\"") || !strstr(line, native)) return 27;
    string_value(line, "\"uuid\"", message, sizeof(message));
    ++turns; f = fopen(state, "w"); if (!f) return 28;
    fprintf(f, "%d", turns); fclose(f); record("turn", turns, 0);
    printf("{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"%s\","
           "\"uuid\":\"10000000-1111-4222-8333-444444444444\"}\n", native); fflush(stdout);
    if (!read_only) {
        printf("{\"type\":\"assistant\",\"session_id\":\"%s\",\"uuid\":\"40000000-1111-4222-8333-444444444444\","
               "\"parent_tool_use_id\":null,\"user_message_uuid\":\"%s\",\"message\":{\"id\":\"msg_progress\",\"role\":\"assistant\","
               "\"content\":[{\"type\":\"text\",\"text\":\"synthetic owner verification wait\"}]}}\n", native, message);
        fflush(stdout);
        mcp_request("orkestr_root_request_submit", "{\"action\":\"synthetic-task\",\"resource\":\"example.invalid\",\"summary\":\"agent requested synthetic review\"}", turns);
        mcp_request("orkestr_desk_login", "{\"operation_id\":\"synthetic-login\"}", turns);
    }
    printf("{\"type\":\"assistant\",\"session_id\":\"%s\",\"uuid\":\"20000000-1111-4222-8333-444444444444\",\"parent_tool_use_id\":null,\"user_message_uuid\":\"%s\","
           "\"message\":{\"id\":\"msg_synthetic\",\"role\":\"assistant\",\"model\":\"synthetic-answer-model\","
           "\"content\":[{\"type\":\"text\",\"text\":\"synthetic Claude turn %d\"}]}}\n", native, message, turns);
    printf("{\"type\":\"result\",\"subtype\":\"success\",\"uuid\":\"30000000-1111-4222-8333-444444444444\",\"is_error\":false,\"session_id\":\"%s\","
           "\"user_message_uuid\":\"%s\",\"result\":\"synthetic Claude turn %d\"}\n", native, message, turns);
    fflush(stdout);
    return fgets(line, sizeof(line), stdin) ? 29 : 0;
}
