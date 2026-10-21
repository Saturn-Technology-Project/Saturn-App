import type { McpConnection, ToolRoute } from "./model.js";

export const COMPUTER_USE_ID = "computer-use";
export const COMPUTER_USE_URL = "builtin://computer-use";
export const CURSOR_COMPUTER_USE_ID = COMPUTER_USE_ID;
export const CURSOR_COMPUTER_USE_URL = COMPUTER_USE_URL;

export const ORIGIN_ID = "origin";
export const ORIGIN_URL = "builtin://origin";
export const CURSOR_ORIGIN_ID = ORIGIN_ID;
export const CURSOR_ORIGIN_URL = ORIGIN_URL;

export const COMPUTER_USE_TOOLS: ToolRoute[] = [
  {
    "toolId": "computer_screenshot",
    "serverId": "computer-use",
    "category": "write",
    "description": "Take a screenshot of the primary display, or of one app's window with an app target. Coordinates are pixels in the fixed 1280×800 screenshot canvas, origin (0, 0) at the top-left. Take one before your first coordinate-based action and whenever the screen may have changed. An app-target screenshot is the image. When a live snapshot is still fresh it reuses that snapshot_id and does not walk. If snapshot_id is present, do not call computer_app_state. Otherwise the image returns without a tree; call computer_app_state when you need element ids.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "target": {
          "description": "Default: {\"scope\":\"app\",\"pid\":…,\"target_id\":…} from computer_apps or computer_resolve_app. That drives one desktop app without taking screen control or moving the real cursor (a cursor overlay is still shown), and needs no computer_start_control. Omit (or {\"scope\":\"screen\"}) only to escalate to full-display remote control.",
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "scope": {
                  "type": "string",
                  "enum": ["screen"]
                }
              },
              "required": [
                "scope"
              ]
            },
            {
              "type": "object",
              "properties": {
                "scope": {
                  "type": "string",
                  "enum": ["app"]
                },
                "pid": {
                  "type": "integer",
                  "minimum": 1,
                  "description": "pid from computer_apps or computer_resolve_app."
                },
                "target_id": {
                  "type": "string",
                  "minLength": 1,
                  "description": "target_id from computer_apps or computer_resolve_app."
                }
              },
              "required": [
                "scope",
                "pid",
                "target_id"
              ]
            }
          ]
        }
      }
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "computer_click",
    "serverId": "computer-use",
    "category": "write",
    "description": "Click at a screen coordinate. Coordinates are pixels in the fixed 1280×800 screenshot canvas, origin (0, 0) at the top-left. Locate the target in a fresh screenshot first. Returns a screenshot taken after the click. With an app target the result is text only; observe again before the next action.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "target": {
          "description": "Default: {\"scope\":\"app\",\"pid\":…,\"target_id\":…} from computer_apps or computer_resolve_app. That drives one desktop app without taking screen control or moving the real cursor (a cursor overlay is still shown), and needs no computer_start_control. Omit (or {\"scope\":\"screen\"}) only to escalate to full-display remote control.",
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "scope": {
                  "type": "string",
                  "enum": ["screen"]
                }
              },
              "required": [
                "scope"
              ]
            },
            {
              "type": "object",
              "properties": {
                "scope": {
                  "type": "string",
                  "enum": ["app"]
                },
                "pid": {
                  "type": "integer",
                  "minimum": 1,
                  "description": "pid from computer_apps or computer_resolve_app."
                },
                "target_id": {
                  "type": "string",
                  "minLength": 1,
                  "description": "target_id from computer_apps or computer_resolve_app."
                }
              },
              "required": [
                "scope",
                "pid",
                "target_id"
              ]
            }
          ]
        },
        "x": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1279,
          "description": "X pixel coordinate in the 1280×800 screenshot canvas."
        },
        "y": {
          "type": "integer",
          "minimum": 0,
          "maximum": 799,
          "description": "Y pixel coordinate in the 1280×800 screenshot canvas."
        },
        "button": {
          "type": "string",
          "enum": [
            "left",
            "right",
            "middle"
          ],
          "description": "Mouse button. Defaults to left."
        },
        "count": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3,
          "description": "Click count; 2 double-clicks. Defaults to 1."
        },
        "coordinate_token": {
          "type": "string",
          "minLength": 1,
          "description": "Required with an app target: the coordinate_token from the latest computer_screenshot of this app. It stays valid until the next screenshot or until the window moves or resizes; screenshot again when an action reports it stale."
        }
      },
      "required": [
        "x",
        "y"
      ]
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "computer_move",
    "serverId": "computer-use",
    "category": "write",
    "description": "Move the mouse cursor to a screen coordinate without clicking. Coordinates are pixels in the fixed 1280×800 screenshot canvas, origin (0, 0) at the top-left. Useful for revealing hover UI. Returns a screenshot taken after the move. With an app target the result is text only; observe again before the next action.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "target": {
          "description": "Default: {\"scope\":\"app\",\"pid\":…,\"target_id\":…} from computer_apps or computer_resolve_app. That drives one desktop app without taking screen control or moving the real cursor (a cursor overlay is still shown), and needs no computer_start_control. Omit (or {\"scope\":\"screen\"}) only to escalate to full-display remote control.",
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "scope": {
                  "type": "string",
                  "enum": ["screen"]
                }
              },
              "required": [
                "scope"
              ]
            },
            {
              "type": "object",
              "properties": {
                "scope": {
                  "type": "string",
                  "enum": ["app"]
                },
                "pid": {
                  "type": "integer",
                  "minimum": 1,
                  "description": "pid from computer_apps or computer_resolve_app."
                },
                "target_id": {
                  "type": "string",
                  "minLength": 1,
                  "description": "target_id from computer_apps or computer_resolve_app."
                }
              },
              "required": [
                "scope",
                "pid",
                "target_id"
              ]
            }
          ]
        },
        "x": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1279,
          "description": "X pixel coordinate in the 1280×800 screenshot canvas."
        },
        "y": {
          "type": "integer",
          "minimum": 0,
          "maximum": 799,
          "description": "Y pixel coordinate in the 1280×800 screenshot canvas."
        },
        "coordinate_token": {
          "type": "string",
          "minLength": 1,
          "description": "Required with an app target: the coordinate_token from the latest computer_screenshot of this app. It stays valid until the next screenshot or until the window moves or resizes; screenshot again when an action reports it stale."
        }
      },
      "required": [
        "x",
        "y"
      ]
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "computer_drag",
    "serverId": "computer-use",
    "category": "write",
    "description": "Press the mouse button at one coordinate, drag to another, and release. Coordinates are pixels in the fixed 1280×800 screenshot canvas, origin (0, 0) at the top-left. Locate both points in a fresh screenshot first. Returns a screenshot taken after the drag. With an app target the result is text only; observe again before the next action.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "target": {
          "description": "Default: {\"scope\":\"app\",\"pid\":…,\"target_id\":…} from computer_apps or computer_resolve_app. That drives one desktop app without taking screen control or moving the real cursor (a cursor overlay is still shown), and needs no computer_start_control. Omit (or {\"scope\":\"screen\"}) only to escalate to full-display remote control.",
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "scope": {
                  "type": "string",
                  "enum": ["screen"]
                }
              },
              "required": [
                "scope"
              ]
            },
            {
              "type": "object",
              "properties": {
                "scope": {
                  "type": "string",
                  "enum": ["app"]
                },
                "pid": {
                  "type": "integer",
                  "minimum": 1,
                  "description": "pid from computer_apps or computer_resolve_app."
                },
                "target_id": {
                  "type": "string",
                  "minLength": 1,
                  "description": "target_id from computer_apps or computer_resolve_app."
                }
              },
              "required": [
                "scope",
                "pid",
                "target_id"
              ]
            }
          ]
        },
        "from": {
          "type": "object",
          "properties": {
            "x": {
              "type": "integer",
              "minimum": 0,
              "maximum": 1279
            },
            "y": {
              "type": "integer",
              "minimum": 0,
              "maximum": 799
            }
          },
          "required": [
            "x",
            "y"
          ],
          "description": "Drag start point in latest-screenshot pixels."
        },
        "to": {
          "type": "object",
          "properties": {
            "x": {
              "type": "integer",
              "minimum": 0,
              "maximum": 1279
            },
            "y": {
              "type": "integer",
              "minimum": 0,
              "maximum": 799
            }
          },
          "required": [
            "x",
            "y"
          ],
          "description": "Drag end point in latest-screenshot pixels."
        },
        "button": {
          "type": "string",
          "enum": [
            "left",
            "right",
            "middle"
          ],
          "description": "Mouse button to hold. Defaults to left."
        },
        "coordinate_token": {
          "type": "string",
          "minLength": 1,
          "description": "Required with an app target: the coordinate_token from the latest computer_screenshot of this app. It stays valid until the next screenshot or until the window moves or resizes; screenshot again when an action reports it stale."
        }
      },
      "required": [
        "from",
        "to"
      ]
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "computer_type",
    "serverId": "computer-use",
    "category": "write",
    "description": "Type into an app. Prefer computer_set_value or computer_type with element_id. Without element_id, inserts into the click-selected field via AX, or the focused field. A missed click target is refused. If nothing is focused, click a field first. Does not raise or move the real cursor. Screen-scope typing is refused. The result is text only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "target": {
          "description": "Default: {\"scope\":\"app\",\"pid\":…,\"target_id\":…} from computer_apps or computer_resolve_app. That drives one desktop app without taking screen control or moving the real cursor (a cursor overlay is still shown), and needs no computer_start_control. Omit (or {\"scope\":\"screen\"}) only to escalate to full-display remote control.",
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "scope": {
                  "type": "string",
                  "enum": ["screen"]
                }
              },
              "required": [
                "scope"
              ]
            },
            {
              "type": "object",
              "properties": {
                "scope": {
                  "type": "string",
                  "enum": ["app"]
                },
                "pid": {
                  "type": "integer",
                  "minimum": 1,
                  "description": "pid from computer_apps or computer_resolve_app."
                },
                "target_id": {
                  "type": "string",
                  "minLength": 1,
                  "description": "target_id from computer_apps or computer_resolve_app."
                }
              },
              "required": [
                "scope",
                "pid",
                "target_id"
              ]
            }
          ]
        },
        "text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4000,
          "description": "Text to type."
        },
        "element_id": {
          "type": "integer",
          "minimum": 1,
          "description": "An element id in brackets from computer_app_state."
        },
        "snapshot_id": {
          "type": "string",
          "minLength": 1,
          "description": "The snapshot_id from computer_app_state, or from a screenshot that reused a live handle. It stays valid across actions until you read a new tree, the window or app changes, or an edit opens a sheet or replaces the tree. Do not call computer_app_state after a screenshot that reused snapshot_id; read computer_app_state when a screenshot omitted the tree or an action reports the snapshot stale."
        },
        "coordinate_token": {
          "type": "string",
          "minLength": 1,
          "description": "Required with an app target: the coordinate_token from the latest computer_screenshot of this app. It stays valid until the next screenshot or until the window moves or resizes; screenshot again when an action reports it stale."
        }
      },
      "required": [
        "text"
      ]
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "computer_key",
    "serverId": "computer-use",
    "category": "write",
    "description": "Press a key or shortcut, such as \"Return\", \"Escape\", \"Tab\", or a chord like \"cmd+l\" on macOS and \"ctrl+l\" on Windows. Combine modifiers with \"+\" (cmd, ctrl, alt, shift). Returns a screenshot taken after the key press. With an app target the result is text only; observe again before the next action.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "target": {
          "description": "Default: {\"scope\":\"app\",\"pid\":…,\"target_id\":…} from computer_apps or computer_resolve_app. That drives one desktop app without taking screen control or moving the real cursor (a cursor overlay is still shown), and needs no computer_start_control. Omit (or {\"scope\":\"screen\"}) only to escalate to full-display remote control.",
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "scope": {
                  "type": "string",
                  "enum": ["screen"]
                }
              },
              "required": [
                "scope"
              ]
            },
            {
              "type": "object",
              "properties": {
                "scope": {
                  "type": "string",
                  "enum": ["app"]
                },
                "pid": {
                  "type": "integer",
                  "minimum": 1,
                  "description": "pid from computer_apps or computer_resolve_app."
                },
                "target_id": {
                  "type": "string",
                  "minLength": 1,
                  "description": "target_id from computer_apps or computer_resolve_app."
                }
              },
              "required": [
                "scope",
                "pid",
                "target_id"
              ]
            }
          ]
        },
        "key": {
          "type": "string",
          "maxLength": 100,
          "description": "Key or shortcut, e.g. \"Return\", \"Tab\", or \"cmd+shift+s\"."
        }
      },
      "required": [
        "key"
      ]
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "computer_scroll",
    "serverId": "computer-use",
    "category": "write",
    "description": "Scroll at a screen coordinate. Coordinates are pixels in the fixed 1280×800 screenshot canvas, origin (0, 0) at the top-left. Returns a screenshot taken after scrolling. With an app target the result is text only; observe again before the next action.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "target": {
          "description": "Default: {\"scope\":\"app\",\"pid\":…,\"target_id\":…} from computer_apps or computer_resolve_app. That drives one desktop app without taking screen control or moving the real cursor (a cursor overlay is still shown), and needs no computer_start_control. Omit (or {\"scope\":\"screen\"}) only to escalate to full-display remote control.",
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "scope": {
                  "type": "string",
                  "enum": ["screen"]
                }
              },
              "required": [
                "scope"
              ]
            },
            {
              "type": "object",
              "properties": {
                "scope": {
                  "type": "string",
                  "enum": ["app"]
                },
                "pid": {
                  "type": "integer",
                  "minimum": 1,
                  "description": "pid from computer_apps or computer_resolve_app."
                },
                "target_id": {
                  "type": "string",
                  "minLength": 1,
                  "description": "target_id from computer_apps or computer_resolve_app."
                }
              },
              "required": [
                "scope",
                "pid",
                "target_id"
              ]
            }
          ]
        },
        "x": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1279,
          "description": "X pixel coordinate in the 1280×800 screenshot canvas."
        },
        "y": {
          "type": "integer",
          "minimum": 0,
          "maximum": 799,
          "description": "Y pixel coordinate in the 1280×800 screenshot canvas."
        },
        "direction": {
          "type": "string",
          "enum": [
            "up",
            "down",
            "left",
            "right"
          ],
          "description": "Scroll direction. Defaults to down."
        },
        "amount": {
          "type": "integer",
          "minimum": 1,
          "maximum": 20,
          "description": "Scroll amount in wheel ticks. Defaults to 3."
        },
        "coordinate_token": {
          "type": "string",
          "minLength": 1,
          "description": "Required with an app target: the coordinate_token from the latest computer_screenshot of this app. It stays valid until the next screenshot or until the window moves or resizes; screenshot again when an action reports it stale."
        }
      },
      "required": [
        "x",
        "y"
      ]
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "computer_wait",
    "serverId": "computer-use",
    "category": "write",
    "description": "Wait before continuing. Short waits (up to 30 s) settle a page load or animation. Longer waits, up to 1 hour, suspend this task and resume it in the same conversation when the time is up: use them to wait for a reply, a build or a deploy, then check again (for example send a message, wait 5 minutes, read the channel, and finish if nobody answered). While suspended nothing runs and no tokens are spent; the result says how long you actually waited. Returns text only; observe afterward with computer_screenshot or computer_app_state, or by calling the tool you are waiting on.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "ms": {
          "type": "integer",
          "minimum": 0,
          "maximum": 3600000,
          "description": "Milliseconds to wait, up to 3600000 (1 hour). Defaults to 1000."
        },
        "reason": {
          "type": "string",
          "description": "What you are waiting for, e.g. 'reply from Alice in #design'. Shown to the user while the task waits."
        }
      }
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "computer_check_permissions",
    "serverId": "computer-use",
    "category": "write",
    "description": "Passively report whether the Accessibility and Screen Recording permissions the computer-use helper needs are granted. On Windows both are always granted. Not needed before acting: an action that needs a missing permission is refused with what the user has to do. Do not call Computer Use tools in parallel; they act on one machine and run one at a time.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "computer_start_control",
    "serverId": "computer-use",
    "category": "write",
    "description": "Escalation only: take over the display and move the real cursor. App targets need no session. Do not call this to type or fill a form.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "computer_release_control",
    "serverId": "computer-use",
    "category": "write",
    "description": "Release remote control after the final screen-scope action.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "computer_apps",
    "serverId": "computer-use",
    "category": "write",
    "description": "List running desktop apps (macOS or Windows), frontmost first, with the pid and target_id an app target needs. Regular applications with a window only: on macOS, Spotlight, Notification Center and menu extras are unsupported. No permission or screen control is required.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "computer_resolve_app",
    "serverId": "computer-use",
    "category": "write",
    "description": "Resolve one desktop app by exactly one selector, launching it if it is not running (in the background on macOS), and return the pid and target_id for its app target.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "pid": {
          "type": "integer",
          "minimum": 1
        },
        "bundle_id": {
          "type": "string",
          "description": "macOS: bundle identifier, e.g. \"com.apple.calculator\". Windows: the executable path that computer_apps reports as bundle_id."
        },
        "app_path": {
          "type": "string",
          "description": "Path to the .app bundle (macOS) or the .exe (Windows)."
        },
        "app_name": {
          "type": "string",
          "description": "App name, e.g. \"Calculator\" on macOS or \"Notepad\" (or a program name the Run dialog knows, such as \"notepad\" or \"calc\") on Windows."
        }
      },
      "oneOf": [
        {
          "required": [
            "pid"
          ]
        },
        {
          "required": [
            "bundle_id"
          ]
        },
        {
          "required": [
            "app_path"
          ]
        },
        {
          "required": [
            "app_name"
          ]
        }
      ]
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "computer_app_state",
    "serverId": "computer-use",
    "category": "write",
    "description": "Read the app's accessibility tree as text (no image): one element per line, \"[id] ROLE name=… value=… settable actions=…\", indented by depth; settable means computer_set_value can replace the value. The last line is the snapshot_id that element actions must quote. Call this when you need the tree (first observe, or a screenshot that omitted snapshot_id). Skip it when a screenshot reused a live snapshot_id. Call again when an action reports the snapshot stale. A line ending in \"(+N descendants omitted)\" was cut to fit: pass that element_id with the current snapshot_id to expand it, and the new ids join the same snapshot.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "target": {
          "type": "object",
          "properties": {
            "scope": {
              "type": "string",
              "enum": ["app"]
            },
            "pid": {
              "type": "integer",
              "minimum": 1,
              "description": "pid from computer_apps or computer_resolve_app."
            },
            "target_id": {
              "type": "string",
              "minLength": 1,
              "description": "target_id from computer_apps or computer_resolve_app."
            }
          },
          "required": [
            "scope",
            "pid",
            "target_id"
          ],
          "description": "The app to act on."
        },
        "element_id": {
          "type": "integer",
          "minimum": 1,
          "description": "An element id in brackets from computer_app_state."
        },
        "snapshot_id": {
          "type": "string",
          "minLength": 1,
          "description": "The snapshot_id from computer_app_state, or from a screenshot that reused a live handle. It stays valid across actions until you read a new tree, the window or app changes, or an edit opens a sheet or replaces the tree. Do not call computer_app_state after a screenshot that reused snapshot_id; read computer_app_state when a screenshot omitted the tree or an action reports the snapshot stale."
        }
      },
      "required": [
        "target"
      ]
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "computer_set_value",
    "serverId": "computer-use",
    "category": "write",
    "description": "Replace the value of a settable element by id through accessibility, without keystrokes. Returns text only; the snapshot_id stays valid while the tree is unchanged, so fill the other elements from the same computer_screenshot or computer_app_state result. If the edit opens a sheet or replaces rows, the result says the snapshot is stale — take a screenshot or read computer_app_state before using element ids.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "target": {
          "type": "object",
          "properties": {
            "scope": {
              "type": "string",
              "enum": ["app"]
            },
            "pid": {
              "type": "integer",
              "minimum": 1,
              "description": "pid from computer_apps or computer_resolve_app."
            },
            "target_id": {
              "type": "string",
              "minLength": 1,
              "description": "target_id from computer_apps or computer_resolve_app."
            }
          },
          "required": [
            "scope",
            "pid",
            "target_id"
          ],
          "description": "The app to act on."
        },
        "element_id": {
          "type": "integer",
          "minimum": 1,
          "description": "An element id in brackets from computer_app_state."
        },
        "snapshot_id": {
          "type": "string",
          "minLength": 1,
          "description": "The snapshot_id from computer_app_state, or from a screenshot that reused a live handle. It stays valid across actions until you read a new tree, the window or app changes, or an edit opens a sheet or replaces the tree. Do not call computer_app_state after a screenshot that reused snapshot_id; read computer_app_state when a screenshot omitted the tree or an action reports the snapshot stale."
        },
        "value": {
          "type": "string",
          "description": "The new value."
        }
      },
      "required": [
        "target",
        "element_id",
        "snapshot_id",
        "value"
      ]
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "computer_app_action",
    "serverId": "computer-use",
    "category": "write",
    "description": "Perform an accessibility action on an element by id: \"press\" for buttons, links, menu items, checkboxes, and tabs (implied, so not listed), or an entry from the element's actions= list such as \"show-menu\" or \"scroll-to-visible\". Prefer this over coordinate clicks when the element is in the tree. Returns text only; the snapshot_id stays valid until the tree changes, so act on more elements from the same computer_screenshot or computer_app_state result.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "target": {
          "type": "object",
          "properties": {
            "scope": {
              "type": "string",
              "enum": ["app"]
            },
            "pid": {
              "type": "integer",
              "minimum": 1,
              "description": "pid from computer_apps or computer_resolve_app."
            },
            "target_id": {
              "type": "string",
              "minLength": 1,
              "description": "target_id from computer_apps or computer_resolve_app."
            }
          },
          "required": [
            "scope",
            "pid",
            "target_id"
          ],
          "description": "The app to act on."
        },
        "element_id": {
          "type": "integer",
          "minimum": 1,
          "description": "An element id in brackets from computer_app_state."
        },
        "snapshot_id": {
          "type": "string",
          "minLength": 1,
          "description": "The snapshot_id from computer_app_state, or from a screenshot that reused a live handle. It stays valid across actions until you read a new tree, the window or app changes, or an edit opens a sheet or replaces the tree. Do not call computer_app_state after a screenshot that reused snapshot_id; read computer_app_state when a screenshot omitted the tree or an action reports the snapshot stale."
        },
        "action": {
          "type": "string",
          "description": "\"press\", or an action name from the element's actions= list."
        }
      },
      "required": [
        "target",
        "element_id",
        "snapshot_id",
        "action"
      ]
    },
    "environments": [
      "production"
    ]
  }
];

export const ORIGIN_TOOLS: ToolRoute[] = [
  {
    "toolId": "get_repository",
    "serverId": "origin",
    "category": "read",
    "description": "Get one Origin repository by owner and name, including default branch, mirror state, visibility, and merge settings.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        }
      },
      "required": [
        "owner",
        "name"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "list_repositories",
    "serverId": "origin",
    "category": "read",
    "description": "List Origin repositories belonging to an owner slug.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "pageSize": {
          "type": "number"
        },
        "pageToken": {
          "type": "string"
        },
        "filter": {
          "type": "string",
          "description": "Case-insensitive repository name substring"
        }
      },
      "required": [
        "owner"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "list_namespaces",
    "serverId": "origin",
    "category": "read",
    "description": "List the Origin namespaces (owner slugs) the caller can list repositories in, ordered by slug. Each slug is a valid owner for list_repositories; viewerCanCreateRepositories reports whether creating a repository there would be allowed. An empty list means the caller has no Origin repositories to read; repositories on GitHub or other hosts are not reachable through these tools.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "pageSize": {
          "type": "number"
        },
        "pageToken": {
          "type": "string"
        }
      },
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "get_file_contents",
    "serverId": "origin",
    "category": "read",
    "description": "Read one path at a ref in an Origin-hosted repository. Files larger than the byte cap are truncated. A directory returns type dir and its immediate children as entries (name, path, type, sha, and size for files) instead of content; entries past the cap are dropped and truncated is set.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "path": {
          "type": "string"
        },
        "ref": {
          "type": "string"
        },
        "startLine": {
          "type": "number"
        },
        "endLine": {
          "type": "number"
        }
      },
      "required": [
        "owner",
        "name",
        "path"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "get_git_tree",
    "serverId": "origin",
    "category": "read",
    "description": "List a git tree in an Origin-hosted repository at a tree SHA, commit SHA, branch, tag, or HEAD. sha defaults to HEAD. Immediate children by default, or the full walk with recursive true. Each entry is path, mode, type (blob, tree, or commit), sha, and size for blobs. Entries past the cap are dropped and truncated is set; list subtrees non-recursively to see more. get_file_contents reads one blob.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "sha": {
          "type": "string",
          "default": "HEAD",
          "description": "Tree SHA, commit SHA, branch, tag, or HEAD. Omit for HEAD."
        },
        "recursive": {
          "type": "boolean",
          "description": "True walks the whole tree; omit for immediate children only"
        }
      },
      "required": [
        "owner",
        "name"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "grep_contents",
    "serverId": "origin",
    "category": "read",
    "description": "Search file contents across one Origin-hosted repository at a ref, which defaults to the default branch. The query is a regular expression matched case-sensitively; set literal for exact text, or caseInsensitive to ignore case (regex mode prefixes (?i) for GrepContents). wholeWord applies only with literal; for regex use \\b. Returns matching lines plus any requested context lines, capped at 1000 matching occurrences, and sets limitHit when that cap is reached. Each returned line contains its full text, so the occurrence cap does not bound response bytes. There is no pagination. Narrow query, filterPath, includes, or excludes to reach other matches.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "query": {
          "type": "string",
          "description": "Regular expression matched case-sensitively by default. Set literal for exact text, or caseInsensitive to ignore case (regex mode prefixes (?i)). wholeWord applies only with literal; for regex use \\b."
        },
        "ref": {
          "type": "string",
          "description": "Branch, tag, or commit to search"
        },
        "literal": {
          "type": "boolean",
          "description": "Match query as exact text"
        },
        "caseInsensitive": {
          "type": "boolean",
          "description": "Ignore case when matching; regex mode prefixes the query with (?i) for GrepContents, and that prefix counts toward the query UTF-8 cap"
        },
        "wholeWord": {
          "type": "boolean",
          "description": "Match whole words only; only applied when literal is true. For regex, use \\b instead."
        },
        "contextBefore": {
          "type": "number",
          "description": "Context lines before each match, at most 10"
        },
        "contextAfter": {
          "type": "number",
          "description": "Context lines after each match, at most 10"
        },
        "filterPath": {
          "type": "string",
          "description": "File or directory to search, relative to the repo root"
        },
        "includes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Globs naming the only paths to search"
        },
        "excludes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Globs naming paths to leave out; an exclude beats an include"
        },
        "maxResults": {
          "type": "number",
          "description": "Matching occurrences to return, at most 1000. Zero uses the default of 1000"
        }
      },
      "required": [
        "owner",
        "name",
        "query"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "list_branches",
    "serverId": "origin",
    "category": "read",
    "description": "List branch names and tip commit SHAs for an Origin-hosted repository. Optional prefix filters each page after pagination.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "pageSize": {
          "type": "number"
        },
        "pageToken": {
          "type": "string"
        },
        "prefix": {
          "type": "string",
          "description": "Case-sensitive branch name prefix. Applied per page after pagination; keep following nextPageToken even when a page has no matches."
        }
      },
      "required": [
        "owner",
        "name"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "list_commits",
    "serverId": "origin",
    "category": "read",
    "description": "List commits from a branch or starting ref in an Origin-hosted repository, optionally filtered by lists of exact git author or committer emails and by inclusive since and until bounds on committer time. A commit matches a list when its email equals any listed email, and must match every list and bound that is given. A filtered page can be short while nextPageToken is present, and is empty with nextPageToken only after 100,000 commits were searched without a match. Keep paging to reach older matches. Each item is sha, full message, author, committer, parents, and tree. Omits patches. Continuation calls reuse the filters stored in pageToken.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "ref": {
          "type": "string",
          "description": "Branch or starting commit"
        },
        "authorEmails": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Only commits whose git author email equals any listed email, case-insensitive. Not names or partial matches. At most 100 distinct emails."
        },
        "committerEmails": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Only commits whose git committer email equals any listed email, case-insensitive. At most 100 distinct emails. Combined with authorEmails, a commit must match both lists."
        },
        "since": {
          "type": "string",
          "description": "Only commits whose git committer time is at or after this RFC 3339 timestamp, such as 2026-08-01T00:00:00Z. The bound is inclusive and uses committer time, which a rebase or cherry-pick rewrites, not author time."
        },
        "until": {
          "type": "string",
          "description": "Only commits whose git committer time is at or before this RFC 3339 timestamp, such as 2026-08-31T23:59:59Z. The bound is inclusive. Combined with since and the email filters, a commit must match every filter that is set."
        },
        "pageSize": {
          "type": "number"
        },
        "pageToken": {
          "type": "string"
        }
      },
      "required": [
        "owner",
        "name"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "commit_read",
    "serverId": "origin",
    "category": "read",
    "description": "Read one commit in an Origin-hosted repository. Choose a single view: metadata, files, or a bounded patch. view defaults to metadata.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "sha": {
          "type": "string"
        },
        "view": {
          "type": "string",
          "default": "metadata",
          "description": "metadata (default), files, or a bounded patch"
        },
        "pageSize": {
          "type": "number"
        },
        "pageToken": {
          "type": "string"
        },
        "startLine": {
          "type": "number"
        },
        "endLine": {
          "type": "number"
        }
      },
      "required": [
        "owner",
        "name",
        "sha"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "compare_commits",
    "serverId": "origin",
    "category": "read",
    "description": "Compare two refs of an Origin-hosted repository relative to their merge base.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "base": {
          "type": "string",
          "description": "Ref the comparison starts from"
        },
        "head": {
          "type": "string",
          "description": "Ref compared against the base"
        }
      },
      "required": [
        "owner",
        "name",
        "base",
        "head"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "list_pull_requests",
    "serverId": "origin",
    "category": "read",
    "description": "List pull requests in an Origin-hosted repository, filtered by state, head, author, base, or stackId and sorted by creation or update time in either direction. Items are compact summaries (author, timestamps, merged/closedAt/mergedAt, and stack membership when the pull request is stacked); they omit body and diff stats—use pull_request_read for those. With stackId, the items are that stack's members in the requested sort order, not stack order; rebuild the tree from each member's stack.parent, and pass state all because the default open state leaves merged members out. Continuation calls must resend those filters with pageToken.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "state": {
          "type": "string",
          "description": "open (default), closed, or all"
        },
        "head": {
          "type": "string",
          "description": "Head branch"
        },
        "author": {
          "type": "string",
          "description": "Actor id (user_…, app_…, or sa_…)"
        },
        "base": {
          "type": "string",
          "description": "Base branch, short name or refs/heads/…"
        },
        "stackId": {
          "type": "string",
          "description": "Stack id (stk_…) from stack.id on a pull request. Lists only that stack's members, in the requested sort order rather than stack order; rebuild the tree from each member's stack.parent. Pass state all to include merged members."
        },
        "direction": {
          "type": "string",
          "description": "desc (default) or asc"
        },
        "sortBy": {
          "type": "string",
          "description": "created (default) or updated"
        },
        "pageSize": {
          "type": "number"
        },
        "pageToken": {
          "type": "string"
        }
      },
      "required": [
        "owner",
        "name"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "pull_request_read",
    "serverId": "origin",
    "category": "read",
    "description": "Read one Origin-hosted pull request through a single view: summary, files, commits, reviews, comments, or threads. view defaults to summary. Summary includes labels, requested reviewers, and stack membership (stack id and parent pull request) when the pull request is stacked. The threads view requires threadIds and pages comments in those threads. Comments and threads carry url, a cursor.com link to that thread or comment on the pull request page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "number": {
          "type": "number"
        },
        "view": {
          "type": "string",
          "default": "summary",
          "description": "summary (default), files, commits, reviews, comments, or threads"
        },
        "pageSize": {
          "type": "number"
        },
        "pageToken": {
          "type": "string"
        },
        "startLine": {
          "type": "number"
        },
        "endLine": {
          "type": "number"
        },
        "threadIds": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Thread ids for the threads view"
        }
      },
      "required": [
        "owner",
        "name",
        "number"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "checks_read",
    "serverId": "origin",
    "category": "read",
    "description": "Read checks for one target in an Origin-hosted repository: a pull request, commit, suite, or run. A top-level ref, sha, or pull number is accepted in place of target. Rollup covers materialized check runs on the current page only and is omitted when nextPageToken is present. Does not fetch external provider logs.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "target": {
          "type": "object",
          "properties": {
            "type": {
              "type": "string"
            },
            "number": {
              "type": "number"
            },
            "sha": {
              "type": "string"
            },
            "checkSuiteId": {
              "type": "string"
            },
            "checkRunId": {
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "additionalProperties": false
        },
        "pageSize": {
          "type": "number"
        },
        "pageToken": {
          "type": "string"
        }
      },
      "required": [
        "owner",
        "name",
        "target"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "create_repository",
    "serverId": "origin",
    "category": "write",
    "description": "Create an empty Origin-hosted repository. Pick an owner from list_namespaces where viewerCanCreateRepositories is true; omit owner to use the caller's personal namespace, which Origin claims on first use (needs an eligible plan, a Privacy Mode that allows code storage, and no team membership; team members pass their team slug). Both steps are one approval: confirm with the user before calling. defaultBranch defaults to main. Repository names are unique per owner, so retrying after a success fails with a conflict; read the repository with get_repository instead. Returns the created repository, including cloneUrl.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "defaultBranch": {
          "type": "string",
          "description": "Default branch name. Omit for main."
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "sync_mirror",
    "serverId": "origin",
    "category": "write",
    "description": "Sync a mirrored repository from upstream, waiting for a ref or optional SHA. Returns completed or pending.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "ref": {
          "type": "string",
          "description": "Full ref to fetch, such as refs/heads/main"
        },
        "sha": {
          "type": "string",
          "description": "Full commit id to wait for; omit to wait on the ref tip"
        }
      },
      "required": [
        "owner",
        "name",
        "ref"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "create_pull_request",
    "serverId": "origin",
    "category": "write",
    "description": "Create a pull request from an already-pushed branch. To stack it, pass parentPullNumber: the base becomes that pull request's head branch (any other base is rejected), and head must have been built on that branch, meaning the two share a commit beyond the parent's own base. A head built off trunk or from unrelated history is rejected with the rebase to run. A head that has since fallen behind the parent is accepted and the response carries needsRestack, because the pull request cannot land until it is restacked; this tool never restacks. stackParent is the stored parent's number, read back after the create.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "title": {
          "type": "string"
        },
        "head": {
          "type": "string",
          "description": "Already-pushed source branch"
        },
        "base": {
          "type": "string",
          "description": "Target branch the pull request merges into. Required without parentPullNumber; with it, omit this or name the parent's head branch."
        },
        "body": {
          "type": "string"
        },
        "draft": {
          "type": "boolean"
        },
        "parentPullNumber": {
          "type": "number",
          "description": "Pull request to stack on, by number. Its head branch becomes the base, and head must have been built on that branch."
        }
      },
      "required": [
        "owner",
        "name",
        "title",
        "head"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "update_pull_request",
    "serverId": "origin",
    "category": "write",
    "description": "Update a pull request's title, description, and lifecycle through the public fields. Omit title or body to leave that field unchanged; pass an empty body to clear the description. Lifecycle is state (open or closed) plus draft, sent independently: state closed closes and ignores draft; state open reopens, and without draft true marks ready and publishes an existing draft; draft true reopens as a draft, alone or together with state open; draft false marks ready and reopens a closed pull request. Send one lifecycle field, both, or neither, so a metadata-only update is valid. Metadata and lifecycle together send one public UpdatePullRequest. Origin applies present fields in its documented order; a failure can leave some fields applied, so re-read after an error. merged is not writable, and ready is draft false or state open rather than a state value.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "number": {
          "type": "number"
        },
        "title": {
          "type": "string",
          "description": "New title. Omit to leave unchanged."
        },
        "body": {
          "type": "string",
          "description": "New description. Omit to leave unchanged. Pass \"\" to clear."
        },
        "state": {
          "type": "string",
          "enum": [
            "open",
            "closed"
          ],
          "description": "open or closed. Omit to leave unchanged."
        },
        "draft": {
          "type": "boolean",
          "description": "Draft flag. Omit to leave unchanged."
        }
      },
      "required": [
        "owner",
        "name",
        "number"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "update_pull_request_base",
    "serverId": "origin",
    "category": "write",
    "description": "Retarget a pull request's base branch, stack it on another pull request, or move it off its stack. With parentPullNumber, the base becomes that pull request's head branch and the stack parent is set in the same update. With base, the pull request is retargeted to that branch: the head branch of an open pull request makes that pull request the parent, and the default branch or a branch with no open pull request moves it off its stack. Stacking is allowed only when this pull request's branch was built on the parent, meaning the two share a commit beyond the parent's own base; a branch built off trunk or from unrelated history is rejected with the rebase to run. A branch that has fallen behind the parent is accepted and the response carries needsRestack, because the pull request cannot land until it is restacked. This tool stacks and unstacks but never restacks: no commit is rebased or replayed. Returns the stored base and head refs, plus stackParent when stacked.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "number": {
          "type": "number"
        },
        "base": {
          "type": "string",
          "description": "Branch to retarget onto. The default branch or a branch with no open pull request unstacks; the head branch of an open pull request stacks on it. Send this or parentPullNumber."
        },
        "parentPullNumber": {
          "type": "number",
          "description": "Pull request to stack on, by number. Its head branch becomes the base. Send this or base."
        }
      },
      "required": [
        "owner",
        "name",
        "number"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "merge_pull_request",
    "serverId": "origin",
    "category": "write",
    "description": "Merge a pull request, or a stack up to and including it. On a stacked pull request this lands every open pull request from the stack root through this one in one commit (one squash commit with squash, one merge commit otherwise); Origin checks every member first and lands nothing if one is blocked. Where a merge queue owns the branch, a single pull request is queued instead, and nothing lands yet. If Origin queues a stack as one merge queue entry instead, its members land in one commit or none do. When the call queues, mergeCommitSha and mergedPrefix are empty, because nothing has landed yet. To land a stack one pull request at a time, merge the lowest open one each time; each becomes its own commit, and the ones above usually need a restack after each landing. Requires the expected head SHA of this pull request. Optional mergeMethod (merge or squash); omit it and Origin picks a method the repository accepts. mergedPrefix lists every pull request that landed. Pull requests above the target stay open; skippedDescendants is currently always empty.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "number": {
          "type": "number"
        },
        "expectedHeadSha": {
          "type": "string"
        },
        "mergeMethod": {
          "type": "string",
          "enum": [
            "merge",
            "squash"
          ],
          "description": "merge or squash. Omit for the repository default."
        }
      },
      "required": [
        "owner",
        "name",
        "number",
        "expectedHeadSha"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "create_pull_request_review",
    "serverId": "origin",
    "category": "write",
    "description": "Submit a comment, approval, or request-changes review on a pull request. Inline review comments are unsupported.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "number": {
          "type": "number"
        },
        "event": {
          "type": "string",
          "description": "COMMENT, APPROVE, or REQUEST_CHANGES"
        },
        "body": {
          "type": "string"
        }
      },
      "required": [
        "owner",
        "name",
        "number",
        "event"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "update_pull_request_review",
    "serverId": "origin",
    "category": "write",
    "description": "Correct the body of an existing pull request review.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "number": {
          "type": "number"
        },
        "reviewId": {
          "type": "string"
        },
        "body": {
          "type": "string"
        }
      },
      "required": [
        "owner",
        "name",
        "number",
        "reviewId",
        "body"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "dismiss_pull_request_review",
    "serverId": "origin",
    "category": "write",
    "description": "Dismiss a submitted approve or request-changes review.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "number": {
          "type": "number"
        },
        "reviewId": {
          "type": "string"
        },
        "message": {
          "type": "string",
          "description": "Reason recorded with the dismissal"
        }
      },
      "required": [
        "owner",
        "name",
        "number",
        "reviewId",
        "message"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "create_pull_request_comment",
    "serverId": "origin",
    "category": "write",
    "description": "Create a general discussion comment on a pull request.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "number": {
          "type": "number"
        },
        "body": {
          "type": "string"
        }
      },
      "required": [
        "owner",
        "name",
        "number",
        "body"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "create_pull_request_inline_comment",
    "serverId": "origin",
    "category": "write",
    "description": "Create a file-level, single-line, or line-range inline comment, optionally against a specific pull request version.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "number": {
          "type": "number"
        },
        "body": {
          "type": "string"
        },
        "anchor": {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "description": "file, line, or range"
            },
            "path": {
              "type": "string",
              "description": "Diff path. Deleted path for deletions; head path otherwise"
            },
            "side": {
              "type": "string",
              "description": "left or right. Required for line and range; omit for file"
            },
            "startLine": {
              "type": "number",
              "description": "1-based first line. Required for line and range"
            },
            "endLine": {
              "type": "number",
              "description": "Inclusive last line. Required for range; omit otherwise"
            }
          },
          "required": [
            "kind",
            "path"
          ],
          "additionalProperties": false
        },
        "versionNumber": {
          "type": "number",
          "description": "Pull request version. Omit or 0 for latest"
        }
      },
      "required": [
        "owner",
        "name",
        "number",
        "body",
        "anchor"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "reply_pull_request_review_thread",
    "serverId": "origin",
    "category": "write",
    "description": "Reply to an existing review thread by thread ID.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "number": {
          "type": "number"
        },
        "threadId": {
          "type": "string",
          "description": "Thread to reply to, from threadId on pull_request_read comments"
        },
        "body": {
          "type": "string"
        }
      },
      "required": [
        "owner",
        "name",
        "number",
        "threadId",
        "body"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "update_pull_request_review_thread",
    "serverId": "origin",
    "category": "write",
    "description": "Resolve or reopen a review thread by thread ID.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "threadId": {
          "type": "string",
          "description": "Thread to resolve or reopen, from threadId on pull_request_read comments"
        },
        "resolved": {
          "type": "boolean",
          "description": "True resolves the thread; false reopens it"
        }
      },
      "required": [
        "owner",
        "name",
        "threadId",
        "resolved"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "update_pull_request_comment",
    "serverId": "origin",
    "category": "write",
    "description": "Correct an existing pull request comment body.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "commentId": {
          "type": "string",
          "description": "Stable comment id from pull_request_read with view comments"
        },
        "body": {
          "type": "string"
        }
      },
      "required": [
        "owner",
        "name",
        "commentId",
        "body"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "update_pull_request_labels",
    "serverId": "origin",
    "category": "write",
    "description": "Replace every label on a pull request with the provided names. Each name must be an existing repository label, spelled exactly, including case; this tool never creates labels. For a label that does not exist yet, call create_label first, then call this tool. Omitted labels are removed. An empty list removes all labels.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "number": {
          "type": "number"
        },
        "labels": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Complete replacement label names. Omitted names are removed. An empty list removes all labels."
        }
      },
      "required": [
        "owner",
        "name",
        "number",
        "labels"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "create_label",
    "serverId": "origin",
    "category": "write",
    "description": "Create a repository label so update_pull_request_labels can apply it. label is the name: 1-50 characters, trimmed, and unique in the repository by exact, case-sensitive spelling, so Bug and bug are different labels; reuse an existing label that differs only in case instead of creating another. color is six hex digits with an optional leading #, such as d73a4a; it defaults to ededed. description is optional, at most 255 characters. A name that already exists returns a conflict; apply that label instead.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "label": {
          "type": "string",
          "description": "Label name to create, 1-50 characters"
        },
        "color": {
          "type": "string",
          "description": "Six hex digits, optional leading #; defaults to ededed"
        },
        "description": {
          "type": "string",
          "description": "Label description, at most 255 characters"
        }
      },
      "required": [
        "owner",
        "name",
        "label"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "request_pull_request_reviewers",
    "serverId": "origin",
    "category": "write",
    "description": "Request reviewers (users and/or groups) on a pull request.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "number": {
          "type": "number"
        },
        "users": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "User identifiers: public user_… id or email"
        },
        "groups": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Group identifiers: public grp_… id, qualified slug, or slug"
        }
      },
      "required": [
        "owner",
        "name",
        "number"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  },
  {
    "toolId": "remove_pull_request_reviewers",
    "serverId": "origin",
    "category": "write",
    "description": "Remove requested reviewers from a pull request.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "Origin namespace (owner) slug, taken from list_namespaces or an earlier Origin result. A GitHub owner or org name is not an Origin namespace unless list_namespaces returns it."
        },
        "name": {
          "type": "string",
          "description": "Origin repository name within that namespace"
        },
        "number": {
          "type": "number"
        },
        "users": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "User identifiers: public user_… id or email"
        },
        "groups": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Group identifiers: public grp_… id, qualified slug, or slug"
        }
      },
      "required": [
        "owner",
        "name",
        "number"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "environments": [
      "production"
    ]
  }
];

export function cursorComputerUseSkills(): McpConnection {
  return {
    id: CURSOR_COMPUTER_USE_ID,
    name: "Computer Use",
    url: CURSOR_COMPUTER_USE_URL,
    tools: COMPUTER_USE_TOOLS,
  };
}

export function cursorOriginSkills(): McpConnection {
  return {
    id: CURSOR_ORIGIN_ID,
    name: "Origin",
    url: CURSOR_ORIGIN_URL,
    tools: ORIGIN_TOOLS,
  };
}
