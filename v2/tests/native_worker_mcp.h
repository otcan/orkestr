/* Disposable Native consumer: actual parallel HTTP calls, never model/provider APIs. */
#include <pthread.h>
static char worker_tasks[2][37];
static void worker_response(const char *tool, int input, const char *response) {
    if (!strcmp(tool, "orkestr_worker_capability")) {
        if (!strstr(response, "\"state\":\"ready\"") ||
            !strstr(response, "\"execution_budget_ms\":300000")) exit(101);
        record("worker-capability", input, 0); return;
    }
    if (!strstr(response, "\"phase\":\"completed\"") ||
        !strstr(response, "\"acceptance_event_id\":") ||
        !strstr(response, "synthetic worker-")) exit(102);
    int slot = input % 10 - 1;
    if (slot < 0 || slot > 1) exit(103);
    const char *structured = strstr(response, "\"structuredContent\":");
    const char *task = structured ? value(structured, "\"task_id\"") : NULL;
    if (!task || *task++ != '"' || !strchr(task, '"') || strchr(task, '"') - task != 36) exit(104);
    if (!strcmp(tool, "orkestr_worker_submit")) {
        memcpy(worker_tasks[slot], task, 36); worker_tasks[slot][36] = 0;
    } else if (strncmp(task, worker_tasks[slot], 36)) exit(105);
    record("worker-result", input, 0);
}
#define ORKESTR_MCP_RESPONSE(tool,input,response) worker_response(tool,input,response)
#include "managed_mcp_native.h"
struct worker_job { int input, slot; };
static void *worker_submit(void *raw) {
    struct worker_job *job = raw;
    char arguments[256];
    snprintf(arguments, sizeof(arguments), "{\"title\":\"Synthetic Worker %d\","
        "\"instructions\":\"synthetic ordinary HTTP input %d\"}", job->slot + 1, job->slot + 41);
    mcp_request("orkestr_worker_submit", arguments, job->input * 10 + job->slot + 1);
    return NULL;
}
static void native_worker_turn(int input) {
    mcp_request("orkestr_worker_capability", "{}", input);
    pthread_t threads[2]; struct worker_job jobs[2] = {{input, 0}, {input, 1}};
    for (int i = 0; i < 2; ++i)
        if (pthread_create(&threads[i], NULL, worker_submit, &jobs[i])) exit(106);
    for (int i = 0; i < 2; ++i) if (pthread_join(threads[i], NULL)) exit(107);
    if (!strcmp(worker_tasks[0], worker_tasks[1])) exit(108);
    for (int i = 0; i < 2; ++i) {
        char arguments[80]; snprintf(arguments, sizeof(arguments), "{\"task_id\":\"%.36s\"}", worker_tasks[i]);
        mcp_request("orkestr_worker_status", arguments, input * 10 + i + 1);
    }
    record("workers-finished", input, 0);
}
