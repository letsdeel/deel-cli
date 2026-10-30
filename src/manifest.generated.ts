// GENERATED FILE — DO NOT EDIT. Produced by the deel-cli-extractor skill from ../../Desktop/openapispec.json plus the PA-7886 interim spec for /v2/logs/* (regenerate from the published spec once the logs endpoints are live).
import type { Manifest } from "./types.ts";

export const manifest: Manifest = {
  "apiTitle": "Deel REST API",
  "descriptors": [
    {
      "command": [
        "adjustments",
        "create"
      ],
      "variant": "invoice",
      "method": "POST",
      "path": "/adjustments/invoice",
      "summary": "Create a single invoice adjustment",
      "async": false,
      "bodyKind": "json",
      "supportsMultipart": false,
      "bodyWrapper": "data",
      "params": [],
      "bodyProps": [
        {
          "name": "type",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "BONUS",
            "COMMISSION",
            "DEDUCTION",
            "EXPENSE",
            "OTHER",
            "OVERTIME",
            "TIME_OFF",
            "VAT"
          ],
          "description": "Invoice adjustment category that determines business rules and downstream invoicing behavior."
        },
        {
          "name": "amount",
          "in": "body",
          "type": "number",
          "required": true,
          "description": "Monetary amount to apply for this invoice adjustment, expressed in the contract currency as a positive number."
        },
        {
          "name": "group_key",
          "in": "body",
          "type": "string",
          "required": false,
          "description": "When provided, invoice adjustments sharing the same group_key within the same payment cycle are merged into a single aggregated line item on the invoice. Requires is_auto_approved to be true."
        },
        {
          "name": "contract_id",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Unique Deel contract identifier (public id) that receives this invoice adjustment line item."
        },
        {
          "name": "description",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Detailed human-readable explanation that appears on invoices and audit records visible to both parties."
        },
        {
          "name": "is_recurring",
          "in": "body",
          "type": "boolean",
          "required": false,
          "description": "Add this invoice adjustment as recurring."
        },
        {
          "name": "date_submitted",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Submission date in ISO-8601 short-date format (YYYY-MM-DD) used for filtering, reporting, and approvals."
        },
        {
          "name": "is_auto_approved",
          "in": "body",
          "type": "boolean",
          "required": false,
          "description": "When true, the created invoice adjustment skips manual approval and is approved immediately on creation."
        },
        {
          "name": "payment_cycle_id",
          "in": "body",
          "type": "string",
          "required": false,
          "description": "Public id (UUID) of the active payment cycle required when creating VAT-related invoice adjustment entries against a specific cycle."
        },
        {
          "name": "hourly_report_preset_id",
          "in": "body",
          "type": "string",
          "required": false,
          "description": "Identifier of an existing hourly report preset used to link standardized rate and scale metadata to this entry."
        }
      ],
      "fileFields": [],
      "responseKind": "object",
      "responseFields": [
        {
          "name": "status",
          "in": "body",
          "type": "string",
          "required": false,
          "enum": [
            "approved",
            "declined",
            "not_payable",
            "paid",
            "pending",
            "processing"
          ],
          "description": "Current processing status assigned to the invoice adjustment after the create workflow finishes executing."
        },
        {
          "name": "created_at",
          "in": "body",
          "type": "string",
          "required": false,
          "description": "ISO-8601 timestamp recording the exact moment the invoice adjustment was created in the system."
        },
        {
          "name": "is_created",
          "in": "body",
          "type": "boolean",
          "required": true,
          "description": "Indicates whether the invoice adjustment record was successfully created by this request."
        },
        {
          "name": "adjustment_id",
          "in": "body",
          "type": "string",
          "required": false,
          "description": "Unique identifier returned for the created invoice adjustment resource after persistence succeeds."
        }
      ]
    },
    {
      "command": [
        "adjustments",
        "create"
      ],
      "variant": "payroll",
      "method": "POST",
      "path": "/adjustments/payroll",
      "summary": "Create a payroll adjustment",
      "async": false,
      "bodyKind": "json",
      "supportsMultipart": false,
      "bodyWrapper": "data",
      "params": [],
      "bodyProps": [
        {
          "name": "type",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Adjustment category name, resolved against GET /adjustments/categories for the contract type."
        },
        {
          "name": "title",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Title of the adjustment."
        },
        {
          "name": "amount",
          "in": "body",
          "type": "number",
          "required": true,
          "description": "Adjustment amount."
        },
        {
          "name": "vendor",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Vendor of the adjustment."
        },
        {
          "name": "country",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "ISO-3166-1 alpha-2 country code; determines currency, matching existing UI behaviour."
        },
        {
          "name": "contract_id",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Deel contract the adjustment applies to. Must resolve to an EOR or Global Payroll contract type."
        },
        {
          "name": "description",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Description of the adjustment."
        },
        {
          "name": "cycle_reference",
          "in": "body",
          "type": "string",
          "required": false,
          "description": "Cycle reference of the adjustment."
        },
        {
          "name": "date_of_adjustment",
          "in": "body",
          "type": "string",
          "required": false,
          "description": "Short date in format ISO-8601 (YYYY-MM-DD)."
        },
        {
          "name": "submitter_profile_id",
          "in": "body",
          "type": "integer",
          "required": false,
          "description": "The identifier of the profile that submits the adjustment. When omitted, the adjustment is attributed to the profile resolved from the API token."
        },
        {
          "name": "should_move_to_next_cycle",
          "in": "body",
          "type": "boolean",
          "required": false,
          "description": "If the adjustment can belong to another payroll cycle."
        }
      ],
      "fileFields": [],
      "responseKind": "object",
      "responseFields": [
        {
          "name": "status",
          "in": "body",
          "type": "string",
          "required": false,
          "description": "Processing status assigned to the adjustment after creation."
        },
        {
          "name": "created_at",
          "in": "body",
          "type": "string",
          "required": false,
          "description": "ISO-8601 timestamp recording when the adjustment was created."
        },
        {
          "name": "adjustment_id",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Unique identifier returned for the created payroll adjustment resource."
        },
        {
          "name": "contract_type",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "EOR",
            "GLOBAL_PAYROLL"
          ],
          "description": "Resolved contract type the adjustment was applied against."
        }
      ]
    },
    {
      "command": [
        "adjustments",
        "create-bulk"
      ],
      "variant": "invoice",
      "method": "POST",
      "path": "/adjustments/invoice/bulk",
      "summary": "Create invoice adjustments in bulk",
      "async": true,
      "bodyKind": "json-array",
      "supportsMultipart": false,
      "bodyWrapper": "data",
      "params": [],
      "bodyProps": [
        {
          "name": "request",
          "in": "body",
          "type": "object",
          "required": true,
          "properties": [
            {
              "name": "type",
              "in": "body",
              "type": "string",
              "required": true,
              "enum": [
                "BONUS",
                "COMMISSION",
                "DEDUCTION",
                "EXPENSE",
                "OTHER",
                "OVERTIME",
                "TIME_OFF",
                "VAT"
              ],
              "description": "Invoice adjustment category that determines business rules and downstream invoicing behavior."
            },
            {
              "name": "amount",
              "in": "body",
              "type": "number",
              "required": true,
              "description": "Monetary amount to apply for this invoice adjustment, expressed in the contract currency as a positive number."
            },
            {
              "name": "group_key",
              "in": "body",
              "type": "string",
              "required": false,
              "description": "When provided, invoice adjustments sharing the same group_key within the same payment cycle are merged into a single aggregated line item on the invoice. Requires is_auto_approved to be true."
            },
            {
              "name": "contract_id",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "Unique Deel contract identifier (public id) that receives this invoice adjustment line item."
            },
            {
              "name": "description",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "Detailed human-readable explanation that appears on invoices and audit records visible to both parties."
            },
            {
              "name": "is_recurring",
              "in": "body",
              "type": "boolean",
              "required": false,
              "description": "Add this invoice adjustment as recurring."
            },
            {
              "name": "date_submitted",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "Submission date in ISO-8601 short-date format (YYYY-MM-DD) used for filtering, reporting, and approvals."
            },
            {
              "name": "is_auto_approved",
              "in": "body",
              "type": "boolean",
              "required": false,
              "description": "When true, the created invoice adjustment skips manual approval and is approved immediately on creation."
            },
            {
              "name": "payment_cycle_id",
              "in": "body",
              "type": "string",
              "required": false,
              "description": "Public id (UUID) of the active payment cycle required when creating VAT-related invoice adjustment entries against a specific cycle."
            },
            {
              "name": "hourly_report_preset_id",
              "in": "body",
              "type": "string",
              "required": false,
              "description": "Identifier of an existing hourly report preset used to link standardized rate and scale metadata to this entry."
            }
          ]
        },
        {
          "name": "external_id",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Client-generated correlation id for an adjustment item. Reuse the same external_id on a later request to link back to the same logical adjustment. This should be provided by client."
        }
      ],
      "maxItems": 50,
      "fileFields": [],
      "responseKind": "object",
      "responseFields": [
        {
          "name": "items",
          "in": "body",
          "type": "array",
          "required": true,
          "properties": [
            {
              "name": "status",
              "in": "body",
              "type": "string",
              "required": true,
              "enum": [
                "PENDING",
                "RUNNING",
                "SUCCEEDED",
                "FAILED"
              ],
              "description": "Initial status when first submitted."
            },
            {
              "name": "external_id",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "The client-supplied correlation id echoed back."
            }
          ]
        },
        {
          "name": "job_id",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Identifier for this operation. Pass to GET /jobs/:job_id to poll the outcome of each item."
        }
      ]
    },
    {
      "command": [
        "adjustments",
        "create-bulk"
      ],
      "variant": "payroll",
      "method": "POST",
      "path": "/adjustments/payroll/bulk",
      "summary": "Process bulk payroll adjustments",
      "async": true,
      "bodyKind": "json",
      "supportsMultipart": false,
      "bodyWrapper": "data",
      "params": [],
      "bodyProps": [
        {
          "name": "items",
          "in": "body",
          "type": "array",
          "required": true,
          "maxItems": 50,
          "description": "Up to 50 adjustments to submit as one batch; each external_id must be unique within the batch."
        }
      ],
      "fileFields": [],
      "responseKind": "object",
      "responseFields": [
        {
          "name": "items",
          "in": "body",
          "type": "array",
          "required": true,
          "properties": [
            {
              "name": "status",
              "in": "body",
              "type": "string",
              "required": true,
              "enum": [
                "PENDING",
                "RUNNING",
                "SUCCEEDED",
                "FAILED"
              ],
              "description": "Initial status when first submitted."
            },
            {
              "name": "external_id",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "The client-supplied correlation id echoed back."
            }
          ]
        },
        {
          "name": "job_id",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Identifier for this operation. Pass to GET /jobs/:job_id to poll the outcome of each item."
        }
      ]
    },
    {
      "command": [
        "jobs",
        "list"
      ],
      "method": "GET",
      "path": "/jobs",
      "summary": "List jobs",
      "async": false,
      "bodyKind": "none",
      "supportsMultipart": false,
      "bodyWrapper": "none",
      "params": [
        {
          "name": "cursor",
          "in": "query",
          "type": "string",
          "required": false,
          "description": "Cursor for keyset pagination, taken from a previous response `page.cursor`"
        },
        {
          "name": "limit",
          "in": "query",
          "type": "integer",
          "required": false,
          "description": "Page size"
        }
      ],
      "bodyProps": [],
      "fileFields": [],
      "responseKind": "array",
      "responseFields": [
        {
          "name": "name",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Name of the operation."
        },
        {
          "name": "job_id",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Identifier of the operation, identical to the job_id returned when it was submitted."
        },
        {
          "name": "status",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "PENDING",
            "RUNNING",
            "SUCCEEDED",
            "FAILED"
          ],
          "description": "Overall status of the operation."
        },
        {
          "name": "created_at",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "When the operation was submitted."
        },
        {
          "name": "created_by",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Identifier of the user or service that submitted the operation."
        }
      ]
    },
    {
      "command": [
        "jobs",
        "status"
      ],
      "method": "GET",
      "path": "/jobs/{job_id}",
      "summary": "Retrieve a job",
      "async": false,
      "bodyKind": "none",
      "supportsMultipart": false,
      "bodyWrapper": "none",
      "params": [
        {
          "name": "job_id",
          "in": "path",
          "type": "string",
          "required": true,
          "description": "Job identifier"
        }
      ],
      "bodyProps": [],
      "fileFields": [],
      "responseKind": "object",
      "responseFields": [
        {
          "name": "items",
          "in": "body",
          "type": "array",
          "required": true,
          "description": "One entry per item processed by the operation.",
          "properties": [
            {
              "name": "error",
              "in": "body",
              "type": "object",
              "required": false,
              "description": "Error detail when this item failed, absent otherwise."
            },
            {
              "name": "status",
              "in": "body",
              "type": "string",
              "required": true,
              "enum": [
                "PENDING",
                "RUNNING",
                "SUCCEEDED",
                "FAILED"
              ],
              "description": "Status of this item."
            },
            {
              "name": "external_id",
              "in": "body",
              "type": "string",
              "required": false,
              "description": "The client-supplied id you provided when submitting the item."
            }
          ]
        },
        {
          "name": "job_id",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Identifier of the job returned when the operation was submitted."
        },
        {
          "name": "status",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "PENDING",
            "RUNNING",
            "SUCCEEDED",
            "FAILED"
          ],
          "description": "Overall status of the operation, derived from all items."
        }
      ]
    },
    {
      "command": [
        "logs",
        "requests",
        "get"
      ],
      "method": "GET",
      "path": "/v2/logs/requests/{request_id}",
      "summary": "Retrieve a request log",
      "async": false,
      "bodyKind": "none",
      "supportsMultipart": false,
      "bodyWrapper": "none",
      "params": [
        {
          "name": "request_id",
          "in": "path",
          "type": "string",
          "required": true,
          "description": "The x-request-id of the request"
        }
      ],
      "bodyProps": [],
      "fileFields": [],
      "responseKind": "object",
      "responseFields": [
        {
          "name": "request_id",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "The x-request-id of the request; quote it when contacting support"
        },
        {
          "name": "timestamp",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "When the response was sent (UTC)"
        },
        {
          "name": "source",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "rest",
            "scim",
            "mcp"
          ],
          "description": "Where the request came in: REST API, SCIM or an MCP tool call"
        },
        {
          "name": "method",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "HTTP method"
        },
        {
          "name": "route",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Public route template the request matched; null when no endpoint matched (404)"
        },
        {
          "name": "path",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Request path without the query string"
        },
        {
          "name": "status",
          "in": "body",
          "type": "integer",
          "required": true,
          "description": "HTTP status returned to the caller"
        },
        {
          "name": "duration_ms",
          "in": "body",
          "type": "integer",
          "required": true,
          "description": "Total time from request start to response end, in milliseconds"
        },
        {
          "name": "upstream_duration_ms",
          "in": "body",
          "type": "integer",
          "required": true,
          "description": "Time spent in the service behind the gateway, in milliseconds; null when the gateway answered itself"
        },
        {
          "name": "token",
          "in": "body",
          "type": "object",
          "required": true,
          "description": "The token that made the request, as the gateway saw it at request time",
          "properties": [
            {
              "name": "id",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "Token id shown in the Developer Center"
            },
            {
              "name": "type",
              "in": "body",
              "type": "string",
              "required": true,
              "enum": [
                "pat",
                "oauth2"
              ],
              "description": "Personal access token or OAuth2 access token"
            },
            {
              "name": "label",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "Token label or OAuth2 client name when the request was made"
            },
            {
              "name": "oauth2_client_id",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "OAuth2 client the token belongs to; null for personal access tokens"
            }
          ]
        },
        {
          "name": "ip",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Client IP address the request came from"
        },
        {
          "name": "user_agent",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "User-Agent header, truncated to 512 characters"
        },
        {
          "name": "api_version",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "API version the request resolved to"
        },
        {
          "name": "response_bytes",
          "in": "body",
          "type": "integer",
          "required": true,
          "description": "Size of the response body in bytes"
        },
        {
          "name": "error",
          "in": "body",
          "type": "object",
          "required": true,
          "description": "Gateway-generated error of a failed request; null when the request succeeded or the error came from the service",
          "properties": [
            {
              "name": "code",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "Machine-readable gateway error code"
            },
            {
              "name": "message",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "Human-readable gateway error message"
            }
          ]
        },
        {
          "name": "gateway_message",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "What the status and gateway error code mean, in plain language"
        },
        {
          "name": "hint",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "What to do about it"
        }
      ]
    },
    {
      "command": [
        "logs",
        "requests",
        "list"
      ],
      "method": "GET",
      "path": "/v2/logs/requests",
      "summary": "List request logs",
      "async": false,
      "bodyKind": "none",
      "supportsMultipart": false,
      "bodyWrapper": "none",
      "params": [
        {
          "name": "request_id",
          "in": "query",
          "type": "string",
          "required": false,
          "description": "Only the request with this x-request-id"
        },
        {
          "name": "token_id",
          "in": "query",
          "type": "string",
          "required": false,
          "description": "Only requests made with this token"
        },
        {
          "name": "route",
          "in": "query",
          "type": "string",
          "required": false,
          "description": "Only requests that matched this route template"
        },
        {
          "name": "path",
          "in": "query",
          "type": "string",
          "required": false,
          "description": "Only requests with exactly this path"
        },
        {
          "name": "method",
          "in": "query",
          "type": "string",
          "required": false,
          "description": "Only requests with this HTTP method"
        },
        {
          "name": "status",
          "in": "query",
          "type": "integer",
          "required": false,
          "description": "Only requests that returned exactly this status"
        },
        {
          "name": "status_class",
          "in": "query",
          "type": "string",
          "required": false,
          "enum": [
            "2xx",
            "4xx",
            "5xx"
          ],
          "description": "Only requests whose status is in this class"
        },
        {
          "name": "source",
          "in": "query",
          "type": "string",
          "required": false,
          "enum": [
            "rest",
            "scim",
            "mcp"
          ],
          "description": "Only requests that came in through this surface"
        },
        {
          "name": "from",
          "in": "query",
          "type": "string",
          "required": false,
          "description": "Start of the window (ISO-8601). Defaults to 24 hours before `to`; a window wider than 15 days is clamped"
        },
        {
          "name": "to",
          "in": "query",
          "type": "string",
          "required": false,
          "description": "End of the window (ISO-8601). Defaults to now"
        },
        {
          "name": "cursor",
          "in": "query",
          "type": "string",
          "required": false,
          "description": "Cursor for keyset pagination, taken from a previous response `page.cursor`"
        },
        {
          "name": "limit",
          "in": "query",
          "type": "integer",
          "required": false,
          "description": "Page size"
        }
      ],
      "bodyProps": [],
      "fileFields": [],
      "responseKind": "array",
      "responseFields": [
        {
          "name": "request_id",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "The x-request-id of the request; quote it when contacting support"
        },
        {
          "name": "timestamp",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "When the response was sent (UTC)"
        },
        {
          "name": "source",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "rest",
            "scim",
            "mcp"
          ],
          "description": "Where the request came in: REST API, SCIM or an MCP tool call"
        },
        {
          "name": "method",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "HTTP method"
        },
        {
          "name": "route",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Public route template the request matched; null when no endpoint matched (404)"
        },
        {
          "name": "path",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Request path without the query string"
        },
        {
          "name": "status",
          "in": "body",
          "type": "integer",
          "required": true,
          "description": "HTTP status returned to the caller"
        },
        {
          "name": "duration_ms",
          "in": "body",
          "type": "integer",
          "required": true,
          "description": "Total time from request start to response end, in milliseconds"
        },
        {
          "name": "upstream_duration_ms",
          "in": "body",
          "type": "integer",
          "required": true,
          "description": "Time spent in the service behind the gateway, in milliseconds; null when the gateway answered itself"
        },
        {
          "name": "token",
          "in": "body",
          "type": "object",
          "required": true,
          "description": "The token that made the request, as the gateway saw it at request time",
          "properties": [
            {
              "name": "id",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "Token id shown in the Developer Center"
            },
            {
              "name": "type",
              "in": "body",
              "type": "string",
              "required": true,
              "enum": [
                "pat",
                "oauth2"
              ],
              "description": "Personal access token or OAuth2 access token"
            },
            {
              "name": "label",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "Token label or OAuth2 client name when the request was made"
            },
            {
              "name": "oauth2_client_id",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "OAuth2 client the token belongs to; null for personal access tokens"
            }
          ]
        },
        {
          "name": "ip",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Client IP address the request came from"
        },
        {
          "name": "user_agent",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "User-Agent header, truncated to 512 characters"
        },
        {
          "name": "api_version",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "API version the request resolved to"
        },
        {
          "name": "response_bytes",
          "in": "body",
          "type": "integer",
          "required": true,
          "description": "Size of the response body in bytes"
        },
        {
          "name": "error",
          "in": "body",
          "type": "object",
          "required": true,
          "description": "Gateway-generated error of a failed request; null when the request succeeded or the error came from the service",
          "properties": [
            {
              "name": "code",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "Machine-readable gateway error code"
            },
            {
              "name": "message",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "Human-readable gateway error message"
            }
          ]
        }
      ]
    },
    {
      "command": [
        "logs",
        "requests",
        "summary"
      ],
      "method": "GET",
      "path": "/v2/logs/requests/summary",
      "summary": "Retrieve request logs summary",
      "async": false,
      "bodyKind": "none",
      "supportsMultipart": false,
      "bodyWrapper": "none",
      "params": [
        {
          "name": "from",
          "in": "query",
          "type": "string",
          "required": false,
          "description": "Start of the window (ISO-8601). Defaults to 24 hours before `to`; a window wider than 15 days is clamped"
        },
        {
          "name": "to",
          "in": "query",
          "type": "string",
          "required": false,
          "description": "End of the window (ISO-8601). Defaults to now"
        }
      ],
      "bodyProps": [],
      "fileFields": [],
      "responseKind": "object",
      "responseFields": [
        {
          "name": "from",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Start of the window the summary covers (UTC)"
        },
        {
          "name": "to",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "End of the window the summary covers (UTC)"
        },
        {
          "name": "total",
          "in": "body",
          "type": "integer",
          "required": true,
          "description": "Requests in the window"
        },
        {
          "name": "by_status_class",
          "in": "body",
          "type": "object",
          "required": true,
          "description": "Requests per status class, keyed by 2xx, 3xx, 4xx, 5xx"
        },
        {
          "name": "rate_limited",
          "in": "body",
          "type": "integer",
          "required": true,
          "description": "Requests rejected with 429 by the rate limiter"
        },
        {
          "name": "p50_ms",
          "in": "body",
          "type": "integer",
          "required": true,
          "description": "Median total latency in milliseconds (bucket upper bound)"
        },
        {
          "name": "p95_ms",
          "in": "body",
          "type": "integer",
          "required": true,
          "description": "95th percentile total latency in milliseconds (bucket upper bound)"
        },
        {
          "name": "active_tokens",
          "in": "body",
          "type": "integer",
          "required": true,
          "description": "Distinct tokens that made at least one request on the days of the window"
        }
      ]
    },
    {
      "command": [
        "logs",
        "tokens",
        "list"
      ],
      "method": "GET",
      "path": "/v2/logs/tokens",
      "summary": "List token activity",
      "async": false,
      "bodyKind": "none",
      "supportsMultipart": false,
      "bodyWrapper": "none",
      "params": [
        {
          "name": "from",
          "in": "query",
          "type": "string",
          "required": false,
          "description": "Start of the window (ISO-8601). Defaults to 24 hours before `to`; a window wider than 15 days is clamped"
        },
        {
          "name": "to",
          "in": "query",
          "type": "string",
          "required": false,
          "description": "End of the window (ISO-8601). Defaults to now"
        },
        {
          "name": "search",
          "in": "query",
          "type": "string",
          "required": false,
          "description": "Only tokens whose label or id contains this text (case-insensitive)"
        },
        {
          "name": "cursor",
          "in": "query",
          "type": "string",
          "required": false,
          "description": "Cursor for keyset pagination, taken from a previous response `page.cursor`"
        },
        {
          "name": "limit",
          "in": "query",
          "type": "integer",
          "required": false,
          "description": "Page size"
        }
      ],
      "bodyProps": [],
      "fileFields": [],
      "responseKind": "array",
      "responseFields": [
        {
          "name": "token",
          "in": "body",
          "type": "object",
          "required": true,
          "description": "The token",
          "properties": [
            {
              "name": "id",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "Token id shown in the Developer Center"
            },
            {
              "name": "type",
              "in": "body",
              "type": "string",
              "required": true,
              "enum": [
                "pat",
                "oauth2"
              ],
              "description": "Personal access token or OAuth2 access token"
            },
            {
              "name": "label",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "Token label or OAuth2 client name at its latest use"
            }
          ]
        },
        {
          "name": "calls",
          "in": "body",
          "type": "integer",
          "required": true,
          "description": "Requests made with the token in the window"
        },
        {
          "name": "errors",
          "in": "body",
          "type": "integer",
          "required": true,
          "description": "Requests that ended in a 4xx or 5xx status"
        },
        {
          "name": "last_used_at",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Latest request made with the token (UTC)"
        },
        {
          "name": "last_ip",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Client IP of that latest request"
        },
        {
          "name": "daily",
          "in": "body",
          "type": "array",
          "required": true,
          "description": "Per-day series over the window, oldest first",
          "properties": [
            {
              "name": "day",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "UTC day"
            },
            {
              "name": "calls",
              "in": "body",
              "type": "integer",
              "required": true,
              "description": "Requests that day"
            },
            {
              "name": "errors",
              "in": "body",
              "type": "integer",
              "required": true,
              "description": "Requests that day ending in a 4xx or 5xx status"
            }
          ]
        }
      ]
    }
  ]
} as const;
