# EC2 Undercut

A static web tool: given a baseline EC2 instance type in a chosen AWS region, find
current-generation instance types with at least as much vCPU count and RAM that cost
less on On-Demand pricing in that same region, while surfacing (not filtering on) other
characteristics that also changed.

## Language

**Region**:
The single AWS region (e.g. `us-east-1`) a search is scoped to, picked from a dropdown
that defaults to `us-east-1`. A **baseline** and its **candidates** are always compared
within the same region — pricing, and even which instance types exist at all, differs by
region, so there's no cross-region matching. Local Zones and Wavelength Zones (e.g.
`us-east-1-bos-1`) aren't offered as regions; see ADR-0004.
_Avoid_: Location, datacenter

**Baseline**:
The EC2 instance type the user enters to compare from.
_Avoid_: Source, input, original instance

**Candidate**:
An instance type being evaluated as a possible match for the baseline.
_Avoid_: Result, option (before it qualifies)

**Match**:
A candidate with vCPU count and RAM (GiB) both greater than or equal to the baseline's
(never less), same OS/region/purchase-option scope, current-generation, and cheaper
on-demand price. Originally exact-only; loosened to "at least as much" because
previous-generation baselines can have odd legacy memory sizes no current-generation
type hits exactly (e.g. c3.2xlarge's 15 GiB) — under strict equality those baselines got
zero matches even though a strictly better, cheaper replacement existed. Any vCPU/RAM
increase over the baseline is called out as a **flagged difference**, same as a
network/storage/architecture change.
_Avoid_: Equivalent, alternative, substitute

**Flagged difference**:
An attribute where the match's value differs from the baseline's, shown alongside a
match rather than used to filter it out: vCPU count or RAM when a match has more than
the baseline (see **Match**), network performance, EBS bandwidth/IOPS, and storage type
(instance-store vs. EBS-only).
_Avoid_: Trade-off, side effect

**Burst-capable**:
An instance type whose CPU performance isn't fixed, via either of two distinct AWS
mechanisms: classic **T-family** (credit-based — earns/spends CPU credits, throttles
hard to baseline once credits run out) or a **flex** family (`c7i-flex`, `c8i-flex`,
`m7i-flex`, `m8i-flex`, `r8i-flex`, ...) — ~40% baseline CPU, bursts to 100% for up to
95% of a rolling 24-hour window, with gradual (not hard) throttling under sustained high
utilization. Unlike an ordinary flagged difference, a burst-capable **candidate** is
highlighted prominently wherever it appears — not just noted when it differs from the
baseline — since it changes CPU performance guarantees rather than a peripheral spec. A
checkbox ("Include burstable instance types", on by default) controls whether
burst-capable rows can appear as **candidates** at all; it never hides a burst-capable
**baseline** itself, only filters candidates.
_Avoid_: Burstable (on its own, implies only T-family and misses flex)

**Excluded type**:
An instance type never considered as a baseline or candidate: any accelerated type (GPU,
FPGA, or inference/training chip) or bare-metal (`.metal`) type. Unlike a flagged
difference, an accelerator or bare-metal access is treated as a hard functional
requirement, not a characteristic to note and move past — so these are removed from the
matchable pool entirely rather than surfaced as a difference.
_Avoid_: Filtered instance, unsupported instance

**Current-generation**:
An instance type AWS marks as current-generation (not scheduled for phase-out). A
**candidate** must always be current-generation. A previous-generation type may still be
used as a **baseline** — converting an old instance to a modern one is the point — it
just never appears as a match itself.
_Avoid_: Modern, latest, non-legacy

**Graviton toggle**:
A user-facing on/off control for whether ARM/Graviton-architecture candidates may appear
alongside x86 ones. Off by default.
_Avoid_: ARM filter, architecture switch

**Savings**:
For a given match, its price difference from the baseline, always expressed as both an
absolute $/hr amount and a percentage.
_Avoid_: Discount, delta
