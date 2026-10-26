/* Fixed synthetic native for the persistent multi-conversation role HTTP oracle. No network I/O. */
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

static char role[16], native[64], turn[100];
static int instance, turns;

static const char *value(const char *line, const char *key) {
    const char *p = strstr(line, key);
    if (!p || !(p = strchr(p, ':'))) return NULL;
    for (++p; *p == ' ' || *p == '\t'; ++p) {}
    return p;
}

static void read_fixed(const char *path, char *out, size_t size) {
    FILE *f = fopen(path, "r");
    if (!f || !fgets(out, size, f)) exit(40);
    out[strcspn(out, "\n")] = 0;
    fclose(f);
}

static void record(const char *kind, int input, int resumed) {
    struct stat ns;
    char line[4096];
    read_fixed("/proc/self/stat", line, sizeof(line));
    char *field = strrchr(line, ')');
    if (!field || stat("/proc/self/ns/pid", &ns)) exit(41);
    field += 2;
    for (int i = 0; i < 19; ++i) {
        field = strchr(field, ' ');
        if (!field) exit(42);
        ++field;
    }
    unsigned long long start = strtoull(field, NULL, 10);
    FILE *f = fopen("/account/sessions/synthetic-role.jsonl", "a");
    if (!f) exit(43);
    fprintf(f, "{\"kind\":\"%s\",\"pid\":%d,\"role\":\"%s\",\"native\":\"%s\","
            "\"instance\":%d,\"pid_namespace\":%llu,\"process_start\":%llu,"
            "\"input_index\":%d,\"resumed\":%s}\n", kind, getpid(), role, native, instance,
            (unsigned long long)ns.st_ino, start, input, resumed ? "true" : "false");
    if (fclose(f)) exit(44);
}

static void save(void) {
    FILE *f = fopen("/account/sessions/synthetic-role-state", "w");
    if (!f) exit(45);
    fprintf(f, "%d %d\n", instance, turns);
    if (fclose(f)) exit(46);
}

static void terminal(const char *status) {
    printf("{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"%s\","
           "\"turn\":{\"id\":\"%s\",\"status\":\"%s\"}}}\n", native, turn, status);
    fflush(stdout);
}

static void held_turn(int input, const char *mode) {
    char release[64];
    snprintf(release, sizeof(release), "release-%d", input);
    time_t deadline = time(NULL) + 60;
    while (access(release, F_OK)) {
        if (time(NULL) >= deadline) exit(47);
        fd_set read; FD_ZERO(&read); FD_SET(STDIN_FILENO, &read);
        struct timeval timeout = {0, 10000};
        int selected = select(1, &read, NULL, NULL, &timeout);
        if (selected < 0) exit(48);
        if (!selected) continue;
        char line[65538];
        if (!fgets(line, sizeof(line), stdin)) exit(0);
        if (!strchr(line, '\n') || !strstr(line, "\"turn/interrupt\"") ||
            !strstr(line, native) || !strstr(line, turn)) exit(49);
        const char *id = value(line, "\"id\"");
        if (!id) exit(50);
        record("interrupt", input, 0);
        printf("{\"id\":%ld,\"result\":{}}\n", strtol(id, NULL, 10));
        fflush(stdout);
        if (!strcmp(mode, "ack-only")) {
            if (fgets(line, sizeof(line), stdin)) exit(51);
            exit(0);
        }
        terminal("interrupted");
        return;
    }
    terminal("completed");
}

static int failure(int code) {
    int last_errno = errno;
    FILE *f = fopen("/account/sessions/synthetic-failure", "a");
    if (f) { fprintf(f, "%d %d\n", code, last_errno); fclose(f); }
    return code;
}

int main(int argc, char **argv) {
    alarm(180); umask(0077);
    setvbuf(stdin, NULL, _IONBF, 0);
    if (argc != 6 || strcmp(argv[1], "-c") || strcmp(argv[2], "features.plugins=false") ||
        strcmp(argv[3], "app-server") || strcmp(argv[4], "--listen") || strcmp(argv[5], "stdio://")) return failure(20);
    if (!getenv("CODEX_HOME") || strcmp(getenv("CODEX_HOME"), "/account") ||
        !getenv("HOME") || strcmp(getenv("HOME"), "/home/provider") ||
        getenv("OPENAI_API_KEY") || getenv("ORKESTR_V2_EXECUTION_SET")) return failure(21);
    char auth[128];
    read_fixed("/account/auth.json", auth, sizeof(auth));
    if (strcmp(auth, "{\"fixture\":\"synthetic-roles-only\"}")) return failure(22);
    int fd = open("/account/auth.json", O_WRONLY);
    if (fd >= 0) { close(fd); return failure(23); }
    if (errno != EROFS) return failure(24);
    fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd >= 0) { close(fd); return failure(25); }
    if (errno != EPERM) return failure(26);
    read_fixed("role", role, sizeof(role));
    if (strcmp(role, "fast") && strcmp(role, "deep") &&
        (strncmp(role, "worker-", 7) || strlen(role) != 8 || role[7] < '0' || role[7] > '3')) return failure(27);
    strcpy(native, "unassigned");
    if (mkdir("/account/sessions", 0700) && errno != EEXIST) return failure(28);
    FILE *state = fopen("/account/sessions/synthetic-role-state", "r");
    if (state) {
        if (fscanf(state, "%d %d", &instance, &turns) != 2) return failure(29);
        fclose(state);
    }
    ++instance; save(); record("spawn", 0, 0);
    char cwd[4096], line[65538];
    if (!getcwd(cwd, sizeof(cwd))) return failure(30);
    int ready = 0;
    while (fgets(line, sizeof(line), stdin)) {
        if (!strchr(line, '\n')) return failure(31);
        const char *method = value(line, "\"method\""), *id = value(line, "\"id\"");
        if (!method) return failure(32);
        long request = id ? strtol(id, NULL, 10) : 0;
        if (!strncmp(method, "\"initialize\"", 12)) {
            printf("{\"id\":%ld,\"result\":{\"userAgent\":\"synthetic\",\"platformFamily\":\"unix\","
                   "\"platformOs\":\"linux\",\"codexHome\":\"synthetic-private\"}}\n", request);
        } else if (!strncmp(method, "\"initialized\"", 13)) {
            if (id) return failure(33);
        } else if (!strncmp(method, "\"account/read\"", 14)) {
            const char *refresh = value(line, "\"refreshToken\"");
            if (!refresh || strncmp(refresh, "false", 5)) return failure(34);
            printf("{\"id\":%ld,\"result\":{\"requiresOpenaiAuth\":true,\"account\":{\"type\":\"chatgpt\"}}}\n", request);
        } else if (!strncmp(method, "\"thread/start\"", 14) || !strncmp(method, "\"thread/resume\"", 15)) {
            int resumed = !strncmp(method, "\"thread/resume\"", 15);
            const char *exclude = value(line, "\"excludeTurns\"");
            if (ready++ || !strstr(line, cwd) ||
                (resumed && (!exclude || strncmp(exclude, "true", 4)))) return failure(35);
            if (resumed) {
                const char *given = value(line, "\"threadId\"");
                if (!given || *given++ != '\"') return failure(52);
                const char *end = strchr(given, '\"');
                if (!end || end - given != 36) return failure(53);
                memcpy(native, given, 36); native[36] = 0;
            } else {
                int group = !strcmp(role, "deep") ? 1 : !strcmp(role, "fast") ? 2 : 3 + role[7] - '0';
                snprintf(native, sizeof(native), "%08d-2222-4333-8444-%012d", group, instance);
            }
            printf("{\"id\":%ld,\"result\":{\"modelProvider\":\"openai\",\"cwd\":\"%s\","
                   "\"approvalPolicy\":\"never\",\"sandbox\":{\"type\":\"readOnly\"},\"thread\":{"
                   "\"id\":\"%s\",\"modelProvider\":\"openai\",\"ephemeral\":false,\"cwd\":\"%s\"}}}\n",
                   request, cwd, native, cwd);
            fflush(stdout); record("ready", 0, resumed);
        } else if (!strncmp(method, "\"turn/start\"", 12)) {
            record("turn-request", 0, 0);
            const char *text = strstr(line, "synthetic ordinary HTTP input");
            /* Fresh Fast receives quoted past evidence before the exact input. */
            if (!strcmp(role, "fast") && text) {
                const char *next = text;
                while ((next = strstr(next + 1, "synthetic ordinary HTTP input"))) text = next;
            }
            if (!ready || !text || !strstr(line, native)) return failure(36);
            text += strlen("synthetic ordinary HTTP input");
            int input = *text == ' ' ? atoi(text + 1) : 1;
            if (input < 1 || input > 100) return failure(37);
            ++turns; save(); snprintf(turn, sizeof(turn), "synthetic-%s-%d", role, turns);
            record("turn", input, 0);
            printf("{\"id\":%ld,\"result\":{\"turn\":{\"id\":\"%s\",\"status\":\"inProgress\"}}}\n", request, turn);
            printf("{\"method\":\"turn/started\",\"params\":{\"threadId\":\"%s\","
                   "\"turn\":{\"id\":\"%s\",\"status\":\"inProgress\"}}}\n", native, turn);
            printf("{\"method\":\"item/agentMessage/delta\",\"params\":{\"threadId\":\"%s\","
                   "\"turnId\":\"%s\",\"delta\":\"synthetic %s progress\"}}\n", native, turn, role);
            fflush(stdout);
            char mode[32]; read_fixed("mode", mode, sizeof(mode));
            if (!strcmp(mode, "complete")) terminal("completed");
            else if (!strcmp(mode, "hold") || !strcmp(mode, "ack-only")) held_turn(input, mode);
            else return failure(38);
        } else return failure(39);
        fflush(stdout);
    }
    return failure(0);
}
