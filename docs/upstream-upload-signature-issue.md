# Upstream issue: the presigned upload URL is rejected by its own storage

**Status:** open, upstream (Higgsfield API/storage). Reported 2026-10-06.
**Impact:** every local-file upload fails. `POST /files/generate-upload-url` returns
`200` with a presigned URL that S3 then rejects with `403 SignatureDoesNotMatch`, so
no bytes are ever stored and the public URL stays inaccessible.

**Reproduce (non-billable, no generation, no credits):**

```bash
HF_CREDENTIALS="KEY_ID:KEY_SECRET" node scripts/repro-upload-signature.mjs
```

It requests a signed URL and PUTs a 67-byte 1×1 PNG, then reads back the public URL.
Expected `200 / 200`, observed `403 / 403`.

---

## Summary

For at least one production credential, the upload flow is unusable:

1. `POST https://api.higgsfield.ai/files/generate-upload-url` with
   `{"content_type":"image/png"}` → **HTTP 200**, returning `upload_url` (a presigned
   S3 URL) and `public_url`.
2. `PUT <upload_url>` with the documented `Content-Type: image/png` → **HTTP 403**:

   ```xml
   <Error><Code>SignatureDoesNotMatch</Code>
     <Message>The request signature we calculated does not match the signature you
     provided. Check your key and signing method.</Message></Error>
   ```

3. `HEAD <public_url>` → **HTTP 403** (nothing was stored).

Any dependent capability fails with it: image-to-video and speech-to-video accept only
remote HTTPS inputs or an uploaded reference, and every local file must be uploaded
first. Text-to-image without a reference is unaffected, which makes this look like a
single-model problem when it is really the file-upload path.

## Environment

|                  |                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------- |
| API base         | `https://api.higgsfield.ai`                                                                 |
| SDK              | `@higgsfield/client@0.2.6` (V1 surface)                                                     |
| Auth             | single-file credential `KEY_ID:KEY_SECRET` (`HF_CREDENTIALS`)                               |
| Bucket           | `fnf-api-input-prod-20250414194641741400000002` (reports `x-amz-bucket-region: eu-north-1`) |
| Credential scope | `…/20261006/eu-north-1/s3/aws4_request` (matches the bucket region)                         |
| Signed headers   | `content-type;host;x-amz-tagging`                                                           |
| Payload hash     | `UNSIGNED-PAYLOAD`                                                                          |
| Node             | v24.16.0 (macOS arm64)                                                                      |
| Probed           | 2026-10-06, multiple times over several hours                                               |

## Raw reproduction with curl

```bash
# 1. ask for a signed URL (prints upload_url / public_url)
curl -s -X POST https://api.higgsfield.ai/files/generate-upload-url \
  -H "hf-api-key: $KEY_ID" -H "hf-secret: $KEY_SECRET" \
  -H "content-type: application/json" \
  -d '{"content_type":"image/png"}'

# 2. PUT a 1x1 PNG to the returned upload_url, byte-for-byte as returned
curl -X PUT -H "content-type: image/png" --data-binary @1x1.png "$UPLOAD_URL"
# -> HTTP 403 SignatureDoesNotMatch
```

## What S3 itself reports

The `SignatureDoesNotMatch` body contains the canonical request S3 computed. It matches
what the client sends, which is the reason this looks like a signing mismatch on the
issuer's side rather than a malformed client request:

```
PUT
/<tenant-id>/<uuid>.png
<the presigned query exactly as issued: X-Amz-Algorithm, X-Amz-Credential, X-Amz-Date,
 X-Amz-Expires, X-Amz-Security-Token, X-Amz-SignedHeaders, X-Amz-Signature>

content-type:image/png
host:fnf-api-input-prod-20250414194641741400000002.s3.amazonaws.com
x-amz-tagging:
                                <- blank line, end of canonical headers
content-type;host;x-amz-tagging
UNSIGNED-PAYLOAD
```

## Ruled out

| Hypothesis                                                   | Evidence against                                                                                                |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Bad/expired credentials                                      | the same credential list/downloads and generates images successfully; the upload-link call returns 200          |
| Insufficient credits / plan                                  | the failure is a storage signature error, raised before any credit accounting                                   |
| Wrong bucket region                                          | the bucket reports `eu-north-1` and the credential scope says `eu-north-1`                                      |
| Missing `x-amz-tagging` header (required by `SignedHeaders`) | sent as an empty value (canonical form `x-amz-tagging:`) — still 403                                            |
| Client URL normalization                                     | a hand-written raw TLS request with a byte-exact path/query and `Host` header — still 403                       |
| Method/headers                                               | `PUT` and `POST`, with `content-type: image/png`, `application/octet-stream`, and no content type — all 403     |
| Endpoint form                                                | virtual-host (`bucket.s3[.region].amazonaws.com`) and path-style (`s3[.region].amazonaws.com/bucket`) — all 403 |
| SDK-specific bug                                             | the same failure reproduces with `node:https`, `fetch`/undici, `curl`, and the SDK's own `axios.put`            |
| Clock skew                                                   | S3 would answer `RequestTimeTooSkewed`; it answers `SignatureDoesNotMatch`                                      |

## Likely cause

The signature embedded in `upload_url` does not verify against the credential and
canonical request it advertises. `X-Amz-Security-Token` is present, i.e. temporary
credentials are used for the presign; a defect in how the signature is computed or in
which session token is used would produce exactly this, and cannot be corrected by any
client, because re-signing requires the secret access key.

**Related SDK defect (secondary):** `@higgsfield/client@0.2.6` performs the upload with
`axios.put(upload_url, data, { headers: { 'Content-Type': contentType } })`
(`dist/client.js`, `upload()`), which never sends `x-amz-tagging` even though the API's
own presign lists it in `X-Amz-SignedHeaders`. Even with a correctly signed URL, that
request could not verify. The header must either be dropped from the signed set or sent
by the SDK.

## Requested fix

1. Make `upload_url` verify: sign it against the exact canonical request the client will
   send (`content-type`, `host`, and any tagging header), or stop including
   `x-amz-tagging` in `X-Amz-SignedHeaders`.
2. Clarify the contract for the upload `PUT`: required method, required headers, and the
   exact `content_type` values accepted (`application/octet-stream` currently answers
   `422`).
3. Update `@higgsfield/client` to send every header it signs (or share the presign
   helper with clients so they cannot diverge).

---

# Second finding: SDK enum drift breaks the default video preset

Independent of the upload defect, the published SDK's enum constants no longer match the
API. `@higgsfield/client@0.2.6` exports
`DoPModel = { LITE: "dop-lite", TURBO: "dop-turbo", STANDARD: "dop-standard" }`, but
`POST /v1/image2video/dop` answers:

```json
{
  "detail": [
    {
      "type": "enum",
      "loc": ["body", "params", "model"],
      "msg": "Input should be 'dop-lite', 'dop-preview' or 'dop-turbo'",
      "input": "dop-standard"
    }
  ]
}
```

So any client that follows the SDK enum sends an invalid model. `SoulSize` has the same
problem in the other direction: the API accepts 16 resolutions, the SDK lists 13.

Accepted values measured from the API's own validation responses (type-invalid probes —
they can never be accepted, so they cannot create a billable job):

| Endpoint               | Parameter          | Accepted                                                                                                                                                                                                     |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/v1/image2video/dop`  | `model`            | `dop-lite`, `dop-preview`, `dop-turbo`                                                                                                                                                                       |
| `/v1/image2video/dop`  | `motions[].id`     | UUID                                                                                                                                                                                                         |
| `/v1/text2image/soul`  | `quality`          | `720p`, `1080p`                                                                                                                                                                                              |
| `/v1/text2image/soul`  | `batch_size`       | `1`, `4`                                                                                                                                                                                                     |
| `/v1/text2image/soul`  | `width_and_height` | `1152x2048`, `2048x1152`, `2048x1536`, `1536x2048`, `1344x2016`, `2016x1344`, `960x1696`, `1536x1536`, `1536x1152`, `1696x960`, `1152x1536`, `1088x1632`, `1632x1088`, `1120x1680`, `1680x1120`, `2048x2048` |
| `/v1/speak/higgsfield` | `quality`          | `high`, `mid`                                                                                                                                                                                                |
| `/v1/speak/higgsfield` | `duration`         | `5`, `10`, `15`                                                                                                                                                                                              |

**Requested fix:** republish the enums (or a `/v1/capabilities` response) so clients do not
have to discover accepted values from 422 responses. Our adapter now validates against the
measured sets and documents how to re-harvest them.

---

## Workaround used while this is open

Pass an HTTPS URL as the input instead of a local file, which skips the upload path
entirely. **Verified end to end on 2026-10-06** with a real (billable) request, which also
shows the account and plan are unaffected by this defect:

|           |                                                                                      |
| --------- | ------------------------------------------------------------------------------------ |
| Command   | `hf video --input <https image> --prompt "…" --preset cinematic --motion "Dolly In"` |
| Result    | `status: completed`, exit `0`, `requestId 71fec110-5840-4a02-b43e-4b19376912f6`      |
| Artifact  | `video.mp4`, 5,454,501 bytes, h264, 1280×720, 30 fps, 5.37 s (161 frames)            |
| Integrity | on-disk SHA-256 matches the manifest (`b3f123ac…`)                                   |
| Wall time | 7m1s of submission + polling                                                         |

Note for compositions: this model returns **1280×720** regardless of the 2048×1152 input,
so scale in the edit rather than expecting a 2048-wide master. Our adapter also now reports this condition accurately instead of mislabeling
it as an account/credit problem:

```
hf doctor --check-upload --json      # non-billable probe of link + PUT + read-back
→ UPLOAD_FAILED, details: { stage: "signed-url-put", status: 403,
                            providerCode: "SignatureDoesNotMatch", storageHost: "…" }
```

See the "Troubleshooting" section of the README for the diagnostic order.
