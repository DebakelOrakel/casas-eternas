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

## Cleaning up after the wire tests (dev only)

The gated wire tests (`CASAS_TEST_S3_AWS=1`) write under the key prefix
`test/`. On the worlds bucket the server's user may not delete an object
version (by design), so every test object leaves noncurrent versions and
delete markers. `test-lifecycle.json` lets S3 remove them: objects,
noncurrent versions and unfinished uploads under `test/` after one day,
and delete markers left alone. It touches nothing outside `test/`.

It needs an administrator (the server's user may not set a lifecycle rule
on the worlds bucket, and should not):

```sh
aws s3api put-bucket-lifecycle-configuration --profile sfe-admin \
  --region eu-central-2 --bucket casas-eternas-dev-worlds \
  --lifecycle-configuration file://deploy/aws/test-lifecycle.json
aws s3api get-bucket-lifecycle-configuration --profile sfe-admin \
  --region eu-central-2 --bucket casas-eternas-dev-worlds
```

Lifecycle rules run about once a day, so leftovers can stay up to two days.
Never put this rule on the public installation's worlds bucket: real worlds
there must not expire (they live outside `test/`, but the rule has no
reason to be there).
