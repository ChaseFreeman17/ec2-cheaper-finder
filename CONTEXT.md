# EC2 Cheaper Finder

A static web tool: given a baseline EC2 instance type, find current-generation instance
types with the exact same vCPU count and RAM that cost less on On-Demand pricing, while
surfacing (not filtering on) other characteristics that also changed.

## Language

**Baseline**:
The EC2 instance type the user enters to compare from.
_Avoid_: Source, input, original instance

**Candidate**:
An instance type being evaluated as a possible match for the baseline.
_Avoid_: Result, option (before it qualifies)

**Match**:
A candidate with the exact same vCPU count and exact same RAM (GiB) as the baseline,
same OS/region/purchase-option scope, current-generation, and cheaper on-demand price.
There is no "at least as much" or partial-match mode — a candidate either matches or it
doesn't.
_Avoid_: Equivalent, alternative, substitute

**Flagged difference**:
An attribute where the match's value differs from the baseline's, shown alongside a
match rather than used to filter it out: network performance, EBS bandwidth/IOPS,
storage type (instance-store vs. EBS-only), and burstable-vs-fixed CPU performance.
_Avoid_: Trade-off, side effect

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
