# deploy/aws/

The object storage identities of a casas-eternas installation on AWS
(docs/design/object-storage.md, DES-0029 — an idea sketch; the server has
no S3 backend yet, so nothing reads these today).

`storage.yaml` — a CloudFormation template for ONE installation: one IAM
user `casas-eternas-<inst>` under the path `/casas-eternas/`, with one
managed policy whose rights are split per bucket:

| bucket | the user may |
|---|---|
| `<prefix>-<inst>-worlds` | create the bucket, set versioning, CORS and the public access block; read, write and delete objects; NOT delete a version or the bucket |
| `<prefix>-<inst>-artifacts` | create the bucket, set CORS, the public access block and lifecycle rules; read, write and delete objects; NOT delete the bucket |

One user while one process runs both stores (it would hold both keys
anyway). Split it into two when the world and artifact targets run in
separate deployments; then the artifacts process holds no key for the
worlds.

The buckets are not in the template: the server creates its bucket when it
is missing. New buckets on AWS are private, block public access and encrypt
by default (SSE-S3), so nothing has to be set for that.

## Steps (with an administrator's credentials)

```sh
# 1. The user and its policy, once per installation.
aws cloudformation deploy \
  --template-file deploy/aws/storage.yaml \
  --stack-name casas-eternas-public-storage \
  --parameter-overrides Installation=public \
  --capabilities CAPABILITY_NAMED_IAM \
  --region eu-central-2

# 2. The access key. The secret is shown ONCE: put it straight into the
#    cluster's Secret, never into a file in the repository.
aws iam create-access-key --user-name casas-eternas-public
```

A second installation (e.g. `dev`) is a second stack with
`Installation=dev`; its user cannot see the other installation's buckets.

Bucket names are global across all of AWS. If `casas-eternas-public-worlds`
is taken, deploy with `BucketPrefix=casas-eternas-<something of yours>`.

Presigned URLs signed with this user's long-term key may live up to
7 days; the server keeps them to minutes (DES-0029).

## Lifecycle rules for the worlds bucket

The worlds bucket is versioned, and the server's user may not delete an
object version (by design): a pruned revision or a deleted world stays as a
noncurrent version, and a delete leaves a delete marker. Without a rule
they stay forever and take space. One rule set per installation:

- `worlds-lifecycle.json` (the public installation): noncurrent versions
  expire 30 days after they became noncurrent, so a pruned revision or a
  deleted world can be recovered for 30 days; delete markers with no
  version left are removed; unfinished multipart uploads go after 7 days.
- `dev-worlds-lifecycle.json` (dev): the same, plus everything under
  `test/` (where the gated wire tests write) after one day.

A put REPLACES the bucket's whole lifecycle configuration, so each bucket
gets exactly one of the two files. Where rules overlap (`test/` on dev),
S3 applies the shorter expiry.

The bucket must exist first (the server creates it at its first start with
`world.storage.type: s3`). It needs an administrator: the server's user may
not set a lifecycle rule on the worlds bucket, and should not.

```sh
# public
aws s3api put-bucket-lifecycle-configuration --profile sfe-admin \
  --region eu-central-2 --bucket casas-eternas-public-worlds \
  --lifecycle-configuration file://deploy/aws/worlds-lifecycle.json

# dev
aws s3api put-bucket-lifecycle-configuration --profile sfe-admin \
  --region eu-central-2 --bucket casas-eternas-dev-worlds \
  --lifecycle-configuration file://deploy/aws/dev-worlds-lifecycle.json

# check
aws s3api get-bucket-lifecycle-configuration --profile sfe-admin \
  --region eu-central-2 --bucket <bucket>
```

Lifecycle rules run about once a day, so an expiry can take a day longer
than its number of days.
