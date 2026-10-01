---
title: Models
description: client.models — the model catalog, single-model reads and published input schemas.
---

```ts
client.models.list(): Promise<ModelRecord[]>
client.models.retrieve(model: string): Promise<ModelRecord>
client.models.paramsSchema(model: string): Promise<unknown | null>
```

## `list()`

Reads the **whole catalog**, across all pages, from `GET /v1/models`. Every call reads the
network; the result also refreshes the cache `paramsSchema` uses. The returned array is a copy.

## `retrieve(model)`

Reads one model by name (`GET /v1/models/{model}`). Names are org-qualified, like
`org/model:fp8`. Raises `NotFoundError` for an unknown name.

## `paramsSchema(model)`

The model's published input schema, or `null` when none is published. Served from the catalog
cache, which is re-read when it is more than five minutes old. Matches `model` against a
record's `id` or its `vorq.family`. `submit` and `batches.submit` call it for
[local validation](./submit.md#local-validation).

## `ModelRecord`

An OpenAI-shaped model object plus a `vorq` block:

| Member | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | The model name you pass to `submit`. |
| `object` | `string` | `"model"`. |
| `owned_by` | `string` | |
| `vorq.model_id` | `string \| number` | The on-chain integer id. `asks`, `floors` and `jobs` filter by it: `Number(model.vorq.model_id)`. |
| `vorq.enabled` | `boolean` | |
| `vorq.family` | `string` | |
| `vorq.params_schema` | `unknown` | The published input schema (JSON Schema subset). |

Fields not named in the type are still present on the value.
