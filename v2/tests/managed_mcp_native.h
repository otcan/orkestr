/* Fixed synthetic HTTP MCP actor; included only in the disposable native oracle. */
#include <arpa/inet.h>
#include <sys/prctl.h>

static char mcp_url[128];

static void mcp_stop_line(const char *line, int input) {
#ifdef ORKESTR_MCP_CLAUDE
    mcp_interrupt(line, input);
#else
    const char *id = value(line, "\"id\"");
    if (!id || !strstr(line, "\"turn/interrupt\"") || !strstr(line, native) || !strstr(line, turn)) exit(88);
    record("interrupt", input, 0);
    printf("{\"id\":%ld,\"result\":{}}\n", strtol(id, NULL, 10));
    terminal("interrupted");
#endif
    /* The actual native stays alive after its interrupt acknowledgement;
       Runtime owns closing the original writer and reaping it. */
    char extra[65538];
    if (fgets(extra, sizeof(extra), stdin)) exit(91);
    exit(0);
}

static void mcp_configuration(int argc, char **argv) {
    if (argc != 6 || strcmp(argv[1], "app-server") || strcmp(argv[2], "-c") ||
        strcmp(argv[4], "--listen") || strcmp(argv[5], "stdio://") ||
        prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) exit(80);
    const char *p = strstr(argv[3], "http://127.0.0.1:");
    if (!p) exit(81);
    size_t size = strcspn(p, "\"");
    if (size >= sizeof(mcp_url)) exit(82);
    memcpy(mcp_url, p, size); mcp_url[size] = 0;
}

static void mcp_request(const char *tool, const char *arguments, int input) {
    char body[8192], frame[10000], response[20000];
    int port = 0;
    if (sscanf(mcp_url, "http://127.0.0.1:%d/mcp", &port) != 1 || port < 1 || port > 65535) exit(83);
    int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons((unsigned short)port)};
    if (fd < 0 || inet_pton(AF_INET, "127.0.0.1", &address.sin_addr) != 1 ||
        connect(fd, (struct sockaddr *)&address, sizeof(address))) exit(84);
    int size = snprintf(body, sizeof(body), "{\"jsonrpc\":\"2.0\",\"id\":\"%d-%s\",\"method\":\"tools/call\","
                        "\"params\":{\"name\":\"%s\",\"arguments\":%s}}", input, tool, tool, arguments);
    if (size < 0 || size >= (int)sizeof(body)) exit(85);
    int length = snprintf(frame, sizeof(frame), "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
                          "Content-Length: %d\r\nConnection: close\r\n\r\n%s", size, body);
    if (length < 0 || length >= (int)sizeof(frame) || write(fd, frame, (size_t)length) != length) exit(86);
    size_t used = 0;
    for (;;) {
        fd_set reads; FD_ZERO(&reads); FD_SET(fd, &reads); FD_SET(STDIN_FILENO, &reads);
        struct timeval timeout = {330, 0};
        if (select(fd + 1, &reads, NULL, NULL, &timeout) <= 0) exit(87);
        if (FD_ISSET(STDIN_FILENO, &reads)) {
            char line[65538];
            if (!fgets(line, sizeof(line), stdin)) exit(0);
            close(fd); mcp_stop_line(line, input);
        }
        if (FD_ISSET(fd, &reads)) {
            ssize_t count = read(fd, response + used, sizeof(response) - 1 - used);
            if (count < 0 || used + (size_t)count >= sizeof(response) - 1) exit(89);
            if (!count) break;
            used += (size_t)count;
        }
    }
    close(fd); response[used] = 0;
    if (strstr(response, "\"isError\":true")) {
        record("tool-cancelled", input, 0);
        char line[65538];
        if (!fgets(line, sizeof(line), stdin)) exit(0);
        mcp_stop_line(line, input);
    }
    if (!strstr(response, "HTTP/1.1 200 OK") || !strstr(response, "\"isError\":false")) exit(90);
#ifdef ORKESTR_MCP_RESPONSE
    ORKESTR_MCP_RESPONSE(tool,input,response);
#else
    record(!strcmp(tool, "orkestr_desk_login") ? "desk-result" : "root-intake-result", input, 0);
#endif
}
