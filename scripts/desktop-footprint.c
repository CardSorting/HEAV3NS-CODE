#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <time.h>
#include <mach/mach_time.h>

// macOS ledger footprint, not RSS or JS heap. Sum is process accounting, not
// unique physical RAM: shared mappings can be represented in multiple ledgers.
int main(int argc, char **argv) {
    unsigned long long total = 0;
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    printf("{\"sampledAt\":%ld,\"machTimebaseNumer\":%u,\"machTimebaseDenom\":%u,\"processes\":[", time(NULL), timebase.numer, timebase.denom);
    for (int i = 1; i < argc; i++) {
        int pid = atoi(argv[i]);
        struct rusage_info_v4 usage = {0};
        if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0) {
            perror("proc_pid_rusage"); return 1;
        }
        if (i > 1) printf(",");
        printf("{\"pid\":%d,\"footprintBytes\":%llu,\"residentBytes\":%llu,\"userTicks\":%llu,\"systemTicks\":%llu}", pid, usage.ri_phys_footprint, usage.ri_resident_size, usage.ri_user_time, usage.ri_system_time);
        total += usage.ri_phys_footprint;
    }
    printf("],\"aggregateFootprintBytes\":%llu}\n", total);
    return 0;
}
