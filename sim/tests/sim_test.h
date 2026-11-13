/*
 * sim_test.h - the test harness: CHECK, a section label, a summary line.
 * One program per tests/test_*.c; `make test` runs them all and stops at the
 * first that fails. Host only.
 */
#ifndef SIM_TEST_H
#define SIM_TEST_H

#include <stdio.h>
#include <stdlib.h>

static int test_checks, test_failures;
static const char *test_section = "";

#define TEST_SECTION(name) (test_section = (name))

#define CHECK(cond)                                                                        \
    do {                                                                                   \
        test_checks++;                                                                     \
        if (!(cond)) {                                                                     \
            test_failures++;                                                               \
            if (test_failures <= 20) {                                                     \
                printf("FAIL %s:%d [%s] %s\n", __FILE__, __LINE__, test_section, #cond);   \
            }                                                                              \
        }                                                                                  \
    } while (0)

/* CHECK with the two values printed when they differ. */
#define CHECK_EQ(a, b)                                                                     \
    do {                                                                                   \
        long long a_ = (long long)(a), b_ = (long long)(b);                                \
        test_checks++;                                                                     \
        if (a_ != b_) {                                                                    \
            test_failures++;                                                               \
            if (test_failures <= 20) {                                                     \
                printf("FAIL %s:%d [%s] %s == %s (%lld vs %lld)\n", __FILE__, __LINE__,    \
                       test_section, #a, #b, a_, b_);                                      \
            }                                                                              \
        }                                                                                  \
    } while (0)

#define TEST_SUMMARY(name)                                                                 \
    do {                                                                                   \
        if (test_failures) {                                                               \
            printf("FAIL %s: %d of %d checks failed\n", name, test_failures, test_checks); \
            return 1;                                                                      \
        }                                                                                  \
        printf("ok   %s: %d checks\n", name, test_checks);                                 \
        return 0;                                                                          \
    } while (0)

/* A small deterministic generator, so a failure repeats. */
static unsigned long long test_seed = 88172645463325252ULL;
static inline unsigned test_random(void)
{
    test_seed ^= test_seed << 13;
    test_seed ^= test_seed >> 7;
    test_seed ^= test_seed << 17;
    return (unsigned)(test_seed >> 32);
}
/* uniform in [lo, hi) */
static inline double test_uniform(double lo, double hi)
{
    return lo + (hi - lo) * (test_random() / 4294967296.0);
}

#endif /* SIM_TEST_H */
