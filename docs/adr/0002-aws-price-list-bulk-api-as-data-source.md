# AWS Price List Bulk API as the data source, not DescribeInstanceTypes or the vantage.sh API

We need both instance specs (vCPU, RAM, network, storage) and On-Demand pricing. AWS
splits these across two APIs: `DescribeInstanceTypes` (precise specs, e.g. exact
baseline/max EBS IOPS and bandwidth numbers, but no price, and requires AWS
credentials) and the Price List API (pricing plus only coarse spec strings like "Up to
10 Gigabit", but the bulk JSON variant needs no credentials at all). vantage.sh's own
instances-api.vantage.sh was also considered — it merges specs and price in one
free-signup call, but its field-level precision for IOPS/bandwidth isn't documented and
it caps at 20 requests/minute.

We chose the AWS Price List Bulk API alone: single source, no credentials required, and
its coarser spec strings are acceptable because network/IOPS/storage differences are
only ever *flagged* for a match, never used to filter or rank it — precision there isn't
load-bearing. If flagged-difference precision becomes important later, `DescribeInstanceTypes`
can be layered in as a second source without changing the pricing pipeline.
