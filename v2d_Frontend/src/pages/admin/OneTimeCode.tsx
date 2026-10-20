import { useState } from "react";
import { Copy } from "lucide-react";
import { Button, Notice } from "../../components/ui";
import { fmtDateTime } from "../../lib/format";

/** Shows a one-time code exactly once. It is never retrievable again — only re-issuable. */
export function OneTimeCode({ username, code, expiresAt, purpose }: { username: string; code: string; expiresAt: string; purpose: "activation" | "reset" }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/${purpose === "activation" ? "activate" : "reset-password"}?u=${encodeURIComponent(username)}`;
  return (
    <div className="stack">
      <Notice tone="warn" title="Shown once">
        Hand this code to the person privately. It can't be displayed again — if it's lost, issue a new one.
      </Notice>
      <dl className="dl">
        <dt>Username</dt>
        <dd className="mono">{username}</dd>
        <dt>{purpose === "activation" ? "Activation code" : "Reset code"}</dt>
        <dd className="mono" style={{ fontSize: "var(--text-xl)", letterSpacing: "0.08em" }}>
          {code}
        </dd>
        <dt>Expires</dt>
        <dd>{fmtDateTime(expiresAt)}</dd>
        <dt>Where</dt>
        <dd className="text-sm">{link}</dd>
      </dl>
      <div>
        <Button
          icon={<Copy size={15} />}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(`Vote2Dine ${purpose}\nUsername: ${username}\nCode: ${code}\nOpen: ${link}`);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy instructions"}
        </Button>
      </div>
    </div>
  );
}
