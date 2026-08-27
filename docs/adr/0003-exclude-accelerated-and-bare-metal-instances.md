# Exclude accelerated and bare-metal instance types entirely, rather than flag them

GPU/FPGA/inference-chip instances (e.g. `p3`, `g4`, `inf1`, `trn1`) and bare-metal
(`.metal`) types can numerically match a plain instance's vCPU/RAM, but the accelerator
or bare-metal access is normally the entire reason that instance type is chosen and
costs more — unlike network throughput or IOPS ceilings, it isn't a "same workload,
slightly different characteristics" difference. Recommending someone drop a GPU to "save
money" would be actively misleading. We exclude these types from the matchable pool
entirely — they're never offered as a candidate, and if a baseline itself is one of
these types, the tool explains why no results are shown rather than silently returning
none. This is a deliberate departure from treating every other spec difference (network,
IOPS, storage type, burstable-vs-fixed) as merely flagged rather than filtered.
