# "At least as much" vCPU/RAM matching, not exact-only

The original design (see CONTEXT.md's original "Match" entry, and the interview that
produced it) deliberately required a candidate's vCPU count and RAM to be *exactly*
equal to the baseline's — explicitly ruling out an "at least as much" mode as a
partial-match compromise that would muddy what "match" means.

That broke down on a real case: `c3.2xlarge` (a previous-generation type, still a valid
**baseline** per ADR-implied support for old→new conversion) has 15 GiB of RAM. No
current-generation instance type is exactly 15 GiB — modern families use round GiB
values (8, 16, 32, ...) — so under strict equality, `c3.2xlarge` (and other
previous-generation types with similar odd legacy sizing) got zero candidates, even
though an 8 vCPU / 16 GiB current-gen type could be strictly better *and* cheaper.

We changed matching to require a candidate's `vcpu` and `memoryGiB` to be **greater than
or equal to** the baseline's (never less), with everything else unchanged: still
current-generation only, still cheaper on-demand, still same OS/region. Any vCPU/RAM
increase over the baseline is now reported the same way a network or storage change is —
as a **flagged difference** — rather than filtered out or hidden, so a teammate can see
exactly how much extra capacity they'd be paying for (or not, since it's already
cheaper).

We considered making this an opt-in toggle (parallel to the Graviton toggle) or a
fallback that only kicks in when zero exact matches exist, to preserve exact-match as
the default. We chose to apply it unconditionally instead: a candidate that has more
vCPU/RAM *and* costs less is strictly better on both axes a teammate cares about, not a
compromise that needs opting into — the flagged-difference badge already surfaces the
size increase for anyone who wants to notice it.
