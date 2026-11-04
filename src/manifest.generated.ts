// GENERATED FILE — DO NOT EDIT. Produced by the deel-cli-extractor skill from ../../Desktop/openapispec.json.
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
        "oauth2-apps",
        "disable"
      ],
      "method": "POST",
      "path": "/oauth2-apps/{app_id}/disable",
      "summary": "Disable an app",
      "confirm": "Disable app {app_id}? This revokes all consents and tokens; enable does not restore them.",
      "async": false,
      "bodyKind": "none",
      "supportsMultipart": false,
      "bodyWrapper": "none",
      "params": [
        {
          "name": "app_id",
          "in": "path",
          "type": "string",
          "required": true,
          "description": "Unique identifier of the app."
        }
      ],
      "bodyProps": [],
      "fileFields": [],
      "responseKind": "object",
      "responseFields": [
        {
          "name": "id",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Unique identifier of the app."
        },
        {
          "name": "name",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Name of the app."
        },
        {
          "name": "type",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "integration"
          ],
          "description": "Kind of app. Integration apps connect your organization to Deel."
        },
        {
          "name": "audience",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "personal",
            "organization"
          ],
          "description": "Whom the app acts for: `personal` for the user who authorizes it, `organization` for the organization."
        },
        {
          "name": "logo_url",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "URL of the app logo. Empty when the app has no logo."
        },
        {
          "name": "api_access",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "enabled",
            "disabled"
          ],
          "description": "Whether the app can currently obtain tokens and call the API."
        },
        {
          "name": "created_at",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Time at which the app was created."
        },
        {
          "name": "created_by",
          "in": "body",
          "type": "object",
          "required": true,
          "description": "Who created the app, or null when unknown.",
          "properties": [
            {
              "name": "name",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "Name of the person who created the app."
            },
            {
              "name": "status",
              "in": "body",
              "type": "string",
              "required": true,
              "enum": [
                "active",
                "left"
              ],
              "description": "Whether the creator still belongs to your organization (`active`) or no longer does (`left`)."
            }
          ]
        },
        {
          "name": "updated_at",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Time at which the app was last updated."
        },
        {
          "name": "client_type",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "public",
            "confidential"
          ],
          "description": "Whether the app can keep a secret. `confidential` apps authenticate with a client secret."
        },
        {
          "name": "description",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "What the app does."
        },
        {
          "name": "website_url",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Website of the app."
        },
        {
          "name": "redirect_uris",
          "in": "body",
          "type": "array",
          "required": true,
          "description": "URLs Deel may send the user back to after they authorize the app."
        }
      ]
    },
    {
      "command": [
        "oauth2-apps",
        "enable"
      ],
      "method": "POST",
      "path": "/oauth2-apps/{app_id}/enable",
      "summary": "Enable an app",
      "async": false,
      "bodyKind": "none",
      "supportsMultipart": false,
      "bodyWrapper": "none",
      "params": [
        {
          "name": "app_id",
          "in": "path",
          "type": "string",
          "required": true,
          "description": "Unique identifier of the app."
        }
      ],
      "bodyProps": [],
      "fileFields": [],
      "responseKind": "object",
      "responseFields": [
        {
          "name": "id",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Unique identifier of the app."
        },
        {
          "name": "name",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Name of the app."
        },
        {
          "name": "type",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "integration"
          ],
          "description": "Kind of app. Integration apps connect your organization to Deel."
        },
        {
          "name": "audience",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "personal",
            "organization"
          ],
          "description": "Whom the app acts for: `personal` for the user who authorizes it, `organization` for the organization."
        },
        {
          "name": "logo_url",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "URL of the app logo. Empty when the app has no logo."
        },
        {
          "name": "api_access",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "enabled",
            "disabled"
          ],
          "description": "Whether the app can currently obtain tokens and call the API."
        },
        {
          "name": "created_at",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Time at which the app was created."
        },
        {
          "name": "created_by",
          "in": "body",
          "type": "object",
          "required": true,
          "description": "Who created the app, or null when unknown.",
          "properties": [
            {
              "name": "name",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "Name of the person who created the app."
            },
            {
              "name": "status",
              "in": "body",
              "type": "string",
              "required": true,
              "enum": [
                "active",
                "left"
              ],
              "description": "Whether the creator still belongs to your organization (`active`) or no longer does (`left`)."
            }
          ]
        },
        {
          "name": "updated_at",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Time at which the app was last updated."
        },
        {
          "name": "client_type",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "public",
            "confidential"
          ],
          "description": "Whether the app can keep a secret. `confidential` apps authenticate with a client secret."
        },
        {
          "name": "description",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "What the app does."
        },
        {
          "name": "website_url",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Website of the app."
        },
        {
          "name": "redirect_uris",
          "in": "body",
          "type": "array",
          "required": true,
          "description": "URLs Deel may send the user back to after they authorize the app."
        }
      ]
    },
    {
      "command": [
        "oauth2-apps",
        "get"
      ],
      "method": "GET",
      "path": "/oauth2-apps/{app_id}",
      "summary": "Retrieve an app",
      "async": false,
      "bodyKind": "none",
      "supportsMultipart": false,
      "bodyWrapper": "none",
      "params": [
        {
          "name": "app_id",
          "in": "path",
          "type": "string",
          "required": true,
          "description": "Unique identifier of the app."
        }
      ],
      "bodyProps": [],
      "fileFields": [],
      "responseKind": "object",
      "responseFields": [
        {
          "name": "id",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Unique identifier of the app."
        },
        {
          "name": "name",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Name of the app."
        },
        {
          "name": "type",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "integration"
          ],
          "description": "Kind of app. Integration apps connect your organization to Deel."
        },
        {
          "name": "audience",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "personal",
            "organization"
          ],
          "description": "Whom the app acts for: `personal` for the user who authorizes it, `organization` for the organization."
        },
        {
          "name": "logo_url",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "URL of the app logo. Empty when the app has no logo."
        },
        {
          "name": "api_access",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "enabled",
            "disabled"
          ],
          "description": "Whether API access is switched on for the app: `disabled` after the app is disabled, by you or by Deel, until it is enabled again."
        },
        {
          "name": "created_at",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Time at which the app was created."
        },
        {
          "name": "created_by",
          "in": "body",
          "type": "object",
          "required": true,
          "nullable": true,
          "description": "Who created the app, or null when unknown.",
          "properties": [
            {
              "name": "name",
              "in": "body",
              "type": "string",
              "required": true,
              "nullable": true,
              "description": "Name of the person who created the app."
            },
            {
              "name": "status",
              "in": "body",
              "type": "string",
              "required": true,
              "enum": [
                "active",
                "left"
              ],
              "description": "Whether the creator still belongs to your organization (`active`) or no longer does (`left`)."
            }
          ]
        },
        {
          "name": "updated_at",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Time at which the app was last updated."
        },
        {
          "name": "client_type",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "public",
            "confidential"
          ],
          "description": "Whether the app can keep a secret. `confidential` apps authenticate with a client secret."
        },
        {
          "name": "description",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "What the app does. Empty when none was set."
        },
        {
          "name": "website_url",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Website of the app. Empty when none was set."
        },
        {
          "name": "redirect_uris",
          "in": "body",
          "type": "array",
          "required": true,
          "description": "URLs Deel may send the user back to after they authorize the app."
        }
      ]
    },
    {
      "command": [
        "oauth2-apps",
        "list"
      ],
      "method": "GET",
      "path": "/oauth2-apps",
      "summary": "List apps",
      "async": false,
      "bodyKind": "none",
      "supportsMultipart": false,
      "bodyWrapper": "none",
      "params": [
        {
          "name": "limit",
          "in": "query",
          "type": "integer",
          "required": false,
          "description": "Maximum number of apps to return in one page, from 1 to 100 (100 when omitted), newest first."
        },
        {
          "name": "cursor",
          "in": "query",
          "type": "string",
          "required": false,
          "description": "Opaque cursor returned as `cursor` by the previous page. Send it to fetch the next page."
        },
        {
          "name": "api_access",
          "in": "query",
          "type": "string",
          "required": false,
          "enum": [
            "enabled",
            "disabled"
          ],
          "description": "Only return apps with this API access."
        }
      ],
      "bodyProps": [],
      "fileFields": [],
      "responseKind": "array",
      "responseFields": [
        {
          "name": "id",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Unique identifier of the app."
        },
        {
          "name": "name",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Name of the app."
        },
        {
          "name": "type",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "integration"
          ],
          "description": "Kind of app. Integration apps connect your organization to Deel."
        },
        {
          "name": "audience",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "personal",
            "organization"
          ],
          "description": "Whom the app acts for: `personal` for the user who authorizes it, `organization` for the organization."
        },
        {
          "name": "logo_url",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "URL of the app logo. Empty when the app has no logo."
        },
        {
          "name": "api_access",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "enabled",
            "disabled"
          ],
          "description": "Whether API access is switched on for the app: `disabled` after the app is disabled, by you or by Deel, until it is enabled again."
        },
        {
          "name": "created_at",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Time at which the app was created."
        },
        {
          "name": "created_by",
          "in": "body",
          "type": "object",
          "required": true,
          "nullable": true,
          "description": "Who created the app, or null when unknown.",
          "properties": [
            {
              "name": "name",
              "in": "body",
              "type": "string",
              "required": true,
              "nullable": true,
              "description": "Name of the person who created the app."
            },
            {
              "name": "status",
              "in": "body",
              "type": "string",
              "required": true,
              "enum": [
                "active",
                "left"
              ],
              "description": "Whether the creator still belongs to your organization (`active`) or no longer does (`left`)."
            }
          ]
        },
        {
          "name": "updated_at",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Time at which the app was last updated."
        },
        {
          "name": "client_type",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "public",
            "confidential"
          ],
          "description": "Whether the app can keep a secret. `confidential` apps authenticate with a client secret."
        },
        {
          "name": "description",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "What the app does. Empty when none was set."
        },
        {
          "name": "website_url",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Website of the app. Empty when none was set."
        },
        {
          "name": "redirect_uris",
          "in": "body",
          "type": "array",
          "required": true,
          "description": "URLs Deel may send the user back to after they authorize the app."
        }
      ]
    },
    {
      "command": [
        "oauth2-apps",
        "update"
      ],
      "method": "PATCH",
      "path": "/oauth2-apps/{app_id}",
      "summary": "Update an app",
      "async": false,
      "bodyKind": "json",
      "supportsMultipart": false,
      "bodyWrapper": "data",
      "params": [
        {
          "name": "app_id",
          "in": "path",
          "type": "string",
          "required": true,
          "description": "Unique identifier of the app."
        }
      ],
      "bodyProps": [
        {
          "name": "name",
          "in": "body",
          "type": "string",
          "required": false,
          "description": "New name of the app."
        },
        {
          "name": "description",
          "in": "body",
          "type": "string",
          "required": false,
          "description": "New description of the app."
        },
        {
          "name": "website_url",
          "in": "body",
          "type": "string",
          "required": false,
          "description": "New website of the app. Must use https."
        },
        {
          "name": "redirect_uris",
          "in": "body",
          "type": "array",
          "required": false,
          "description": "New list of redirect URLs. It replaces the current list. At most 10, no duplicates, https only (http is accepted for 127.0.0.1 and [::1] outside production).",
          "maxItems": 10
        }
      ],
      "fileFields": [],
      "responseKind": "object",
      "responseFields": [
        {
          "name": "id",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Unique identifier of the app."
        },
        {
          "name": "name",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Name of the app."
        },
        {
          "name": "type",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "integration"
          ],
          "description": "Kind of app. Integration apps connect your organization to Deel."
        },
        {
          "name": "audience",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "personal",
            "organization"
          ],
          "description": "Whom the app acts for: `personal` for the user who authorizes it, `organization` for the organization."
        },
        {
          "name": "logo_url",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "URL of the app logo. Empty when the app has no logo."
        },
        {
          "name": "api_access",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "enabled",
            "disabled"
          ],
          "description": "Whether the app can currently obtain tokens and call the API."
        },
        {
          "name": "created_at",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Time at which the app was created."
        },
        {
          "name": "created_by",
          "in": "body",
          "type": "object",
          "required": true,
          "description": "Who created the app, or null when unknown.",
          "properties": [
            {
              "name": "name",
              "in": "body",
              "type": "string",
              "required": true,
              "description": "Name of the person who created the app."
            },
            {
              "name": "status",
              "in": "body",
              "type": "string",
              "required": true,
              "enum": [
                "active",
                "left"
              ],
              "description": "Whether the creator still belongs to your organization (`active`) or no longer does (`left`)."
            }
          ]
        },
        {
          "name": "updated_at",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Time at which the app was last updated."
        },
        {
          "name": "client_type",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "public",
            "confidential"
          ],
          "description": "Whether the app can keep a secret. `confidential` apps authenticate with a client secret."
        },
        {
          "name": "description",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "What the app does."
        },
        {
          "name": "website_url",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Website of the app."
        },
        {
          "name": "redirect_uris",
          "in": "body",
          "type": "array",
          "required": true,
          "description": "URLs Deel may send the user back to after they authorize the app."
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
        "app-store",
        "categories"
      ],
      "method": "GET",
      "path": "/app-store/categories",
      "summary": "List App Store categories",
      "async": false,
      "bodyKind": "none",
      "supportsMultipart": false,
      "bodyWrapper": "none",
      "params": [],
      "bodyProps": [],
      "fileFields": [],
      "responseKind": "array",
      "responseFields": [
        {
          "name": "id",
          "in": "body",
          "type": "integer",
          "required": true,
          "description": "Unique identifier of the category."
        },
        {
          "name": "name",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Name of the category."
        }
      ]
    },
    {
      "command": [
        "oauth2-apps",
        "listing",
        "get"
      ],
      "method": "GET",
      "path": "/oauth2-apps/{app_id}/listing",
      "summary": "Retrieve the listing of an app",
      "async": false,
      "bodyKind": "none",
      "supportsMultipart": false,
      "bodyWrapper": "none",
      "params": [
        {
          "name": "app_id",
          "in": "path",
          "type": "string",
          "required": true,
          "description": "Unique identifier of the app."
        }
      ],
      "bodyProps": [],
      "fileFields": [],
      "responseKind": "object",
      "responseFields": [
        {
          "name": "app_id",
          "in": "body",
          "type": "string",
          "required": true,
          "description": "Unique identifier of the app the listing belongs to."
        },
        {
          "name": "name",
          "in": "body",
          "type": "string",
          "required": false,
          "description": "Name of the listing in the App Store."
        },
        {
          "name": "status",
          "in": "body",
          "type": "string",
          "required": true,
          "enum": [
            "published",
            "unpublished"
          ],
          "description": "Whether the listing is live in the App Store. It stays `published` while a newer revision is reviewed."
        },
        {
          "name": "latest_revision",
          "in": "body",
          "type": "object",
          "required": true,
          "nullable": true,
          "description": "The version of the listing you are working on or that is under review. Null until the listing has content.",
          "properties": [
            {
              "name": "status",
              "in": "body",
              "type": "string",
              "required": false,
              "enum": [
                "draft",
                "in_review",
                "published",
                "rejected"
              ],
              "description": "Where the revision stands. Only a draft can be edited and submitted."
            },
            {
              "name": "review_notes",
              "in": "body",
              "type": "string",
              "required": false,
              "nullable": true,
              "description": "The reviewer’s notes when the revision was rejected."
            }
          ]
        },
        {
          "name": "first_published_at",
          "in": "body",
          "type": "string",
          "required": true,
          "nullable": true,
          "description": "When the listing was first approved. Null until then."
        },
        {
          "name": "short_description",
          "in": "body",
          "type": "string",
          "required": false,
          "nullable": true,
          "description": "Tagline shown on the listing card."
        },
        {
          "name": "product_description",
          "in": "body",
          "type": "string",
          "required": false,
          "nullable": true,
          "description": "What the app does."
        },
        {
          "name": "feature_description",
          "in": "body",
          "type": "string",
          "required": false,
          "nullable": true,
          "description": "Features of the app."
        },
        {
          "name": "setup_description",
          "in": "body",
          "type": "string",
          "required": false,
          "nullable": true,
          "description": "How to set the app up."
        },
        {
          "name": "pricing_description",
          "in": "body",
          "type": "string",
          "required": false,
          "nullable": true,
          "description": "What the app costs."
        },
        {
          "name": "main_description_title",
          "in": "body",
          "type": "string",
          "required": false,
          "nullable": true,
          "description": "Title of the main description on the store page."
        },
        {
          "name": "main_description_body",
          "in": "body",
          "type": "string",
          "required": false,
          "nullable": true,
          "description": "Body of the main description on the store page."
        },
        {
          "name": "how_it_works",
          "in": "body",
          "type": "string",
          "required": false,
          "nullable": true,
          "description": "How the app works."
        },
        {
          "name": "landing_page_url",
          "in": "body",
          "type": "string",
          "required": false,
          "nullable": true,
          "description": "Landing page of the app."
        },
        {
          "name": "help_url",
          "in": "body",
          "type": "string",
          "required": false,
          "nullable": true,
          "description": "Help center of the app."
        },
        {
          "name": "faq_url",
          "in": "body",
          "type": "string",
          "required": false,
          "nullable": true,
          "description": "FAQ of the app."
        },
        {
          "name": "demo_video_url",
          "in": "body",
          "type": "string",
          "required": false,
          "nullable": true,
          "description": "Demo video of the app."
        },
        {
          "name": "support_email",
          "in": "body",
          "type": "string",
          "required": false,
          "nullable": true,
          "description": "Where customers reach your support."
        },
        {
          "name": "escalation_email",
          "in": "body",
          "type": "string",
          "required": false,
          "nullable": true,
          "description": "Where Deel escalates urgent issues."
        },
        {
          "name": "highlights",
          "in": "body",
          "type": "array",
          "required": false,
          "description": "Highlights shown on the store page.",
          "properties": [
            {
              "name": "title",
              "in": "body",
              "type": "string",
              "required": false,
              "nullable": true,
              "description": "Title of the highlight."
            },
            {
              "name": "text",
              "in": "body",
              "type": "string",
              "required": false,
              "description": "Text of the highlight."
            }
          ]
        },
        {
          "name": "support_resources",
          "in": "body",
          "type": "array",
          "required": false,
          "description": "Support links shown on the store page.",
          "properties": [
            {
              "name": "name",
              "in": "body",
              "type": "string",
              "required": false,
              "description": "Name of the link."
            },
            {
              "name": "url",
              "in": "body",
              "type": "string",
              "required": false,
              "nullable": true,
              "description": "Address of the link."
            }
          ]
        },
        {
          "name": "works_with",
          "in": "body",
          "type": "array",
          "required": false,
          "description": "Deel products the app works with.",
          "properties": [
            {
              "name": "name",
              "in": "body",
              "type": "string",
              "required": false,
              "description": "Name of the link."
            },
            {
              "name": "url",
              "in": "body",
              "type": "string",
              "required": false,
              "nullable": true,
              "description": "Address of the link."
            }
          ]
        },
        {
          "name": "what_it_syncs",
          "in": "body",
          "type": "array",
          "required": false,
          "description": "What the app syncs."
        },
        {
          "name": "categories",
          "in": "body",
          "type": "array",
          "required": true,
          "description": "App Store categories of the revision.",
          "properties": [
            {
              "name": "id",
              "in": "body",
              "type": "integer",
              "required": false,
              "description": "Unique identifier of the category."
            },
            {
              "name": "name",
              "in": "body",
              "type": "string",
              "required": false,
              "description": "Name of the category."
            }
          ]
        },
        {
          "name": "logo_url",
          "in": "body",
          "type": "string",
          "required": true,
          "nullable": true,
          "description": "Public URL of the logo of the revision in `latest_revision`, as saved. Null only when no logo has been set."
        },
        {
          "name": "media_gallery",
          "in": "body",
          "type": "array",
          "required": true,
          "description": "Images and videos of the revision in `latest_revision`, as saved. Empty when none has been set.",
          "properties": [
            {
              "name": "url",
              "in": "body",
              "type": "string",
              "required": false,
              "description": "Public URL of the item."
            },
            {
              "name": "type",
              "in": "body",
              "type": "string",
              "required": false,
              "enum": [
                "image",
                "video"
              ],
              "description": "Whether the item is an image or a video."
            },
            {
              "name": "caption",
              "in": "body",
              "type": "string",
              "required": false,
              "nullable": true,
              "description": "Caption of the item."
            }
          ]
        }
      ]
    }
  ]
} as const;
