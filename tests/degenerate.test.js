/**
 * Tests for the degenerate-output guard.
 *
 *   node --test tests/
 *
 * A 7B on a CPU will fall into a repetition loop. Observed on the running
 * system:
 *
 *   Q: "s3 HTTPS encription"
 *   - HTTPS in transit is separate from encryption at rest for S3 objects.
 *   - HTTPS is enabled by default for S3 buckets.
 *   ... seven good bullets ...
 *   - HTTPS can be used to secure access to S3 objects and buckets from the
 *     internet or within a VPC.     <- repeated 15 times, to the token limit
 *
 * The loop is not just a bad answer: cached, it is served to every future
 * request for that question. So a degenerate answer must never be cached, and
 * one that is already cached must be evicted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { detectDegeneracy } from "../src/degenerate.js";

// The exact shape that was observed.
const REPORTED = `Key points:
- HTTPS in transit is separate from encryption at rest for S3 objects.
- HTTPS is enabled by default for S3 buckets.
- HTTPS ensures data is encrypted during transmission between the client and the S3 endpoint.
- HTTPS can be configured to use client-side certificates for mutual authentication.
- HTTPS is supported for all S3 operations, including GET, PUT, DELETE, and multipart uploads.
- HTTPS can be used to secure access to S3 objects and buckets from the internet or within a VPC.
- HTTPS can be configured to use custom domain names for S3 buckets.
- HTTPS can be used to secure access to S3 objects and buckets from the internet or within a VPC.
- HTTPS can be used to secure access to S3 objects and buckets from the internet or within a VPC.
- HTTPS can be used to secure access to S3 objects and buckets from the internet or within a VPC.
- HTTPS can be used to secure access to S3 objects and buckets from the internet or within a VPC.
- HTTPS can be used to secure access to S3 objects and buckets from the internet or within a VPC.
- HTTPS can be used to secure access to S3 objects and buckets from the internet or within a VPC.
- HTTPS can be used to secure access to S3 objects and buckets from the internet or within a VPC.`;

const HEALTHY = `Key points:
- Amazon S3 server-side encryption with SSE-KMS uses a customer managed key in AWS Key Management Service.
- HTTPS in transit is separate from encryption at rest; it protects the request between the client and the S3 endpoint.
- The SSE-KMS key lifecycle, including rotation and scheduled deletion, is controlled from the KMS console.
- You are charged per KMS API call, so bucket keys reduce cost on high-throughput workloads.`;

test("the reported repetition loop is detected", () => {
  const d = detectDegeneracy(REPORTED);
  assert.ok(d.degenerate, "the reported loop must be detected");
  assert.match(d.reason, /same line appears/);
  assert.ok(d.metric >= 3);
});

test("a healthy answer is not flagged", () => {
  const d = detectDegeneracy(HEALTHY);
  assert.ok(!d.degenerate, `a healthy answer must pass: ${d.reason}`);
});

test("a short answer is not flagged", () => {
  assert.equal(detectDegeneracy("Key points:\n- fine.").degenerate, false);
  assert.equal(detectDegeneracy("").degenerate, false);
  assert.equal(detectDegeneracy(null).degenerate, false);
});

test("a repeated n-gram is detected even when the lines differ slightly", () => {
  const base = "the cache serves the answer without calling the model again and again";
  const text = `Key points:\n- ${base}.\n- ${base} for the next request.\n- ${base} and so on.\n- ${base} once more.`;
  const d = detectDegeneracy(text);
  assert.ok(d.degenerate, "a repeated n-gram must be detected");
});

test("an answer that simply ends without a full stop is NOT degenerate", () => {
  // a bullet list's last line often has no trailing period; that is not a loop
  const text = `Key points:
- An instance lives in exactly one Availability Zone.
- An instance without a public address reaches the internet only through a NAT gateway`;
  const d = detectDegeneracy(text);
  assert.ok(!d.degenerate, `must not be flagged: ${d.reason}`);
});

test("a well-formed long answer that ends in a full stop is not flagged", () => {
  const text = [
    "Amazon S3 is an object storage service that keeps data as objects inside buckets.",
    "Every object is addressed by a key, which is its full path within the bucket.",
    "A bucket name is globally unique across all of AWS, and objects may be up to five terabytes.",
    "S3 is designed for eleven nines of durability and three or more nines of availability.",
    "Buckets are private by default until a bucket policy or an IAM policy grants access.",
    "Common operations include PUT to write an object and GET to read one back.",
    "Objects carry metadata, tags and a storage class, and can be versioned.",
  ].join("\n");
  const d = detectDegeneracy(text);
  assert.ok(!d.degenerate, `must not be flagged: ${d.reason}`);
});

test("two similar bullets are fine", () => {
  // near-duplicates are common and legitimate; only REPEATS are degenerate
  const text = `Key points:
- Amazon S3 stores objects inside buckets, addressed by a key.
- Amazon S3 stores objects inside a bucket, addressed by a full key path.
- Buckets are globally unique across all of AWS.
- Objects range from zero bytes to five terabytes.`;
  assert.equal(detectDegeneracy(text).degenerate, false);
});
