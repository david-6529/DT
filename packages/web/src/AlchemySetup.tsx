import { useState } from "react";
import { api } from "./api.js";

interface Props {
  onSaved: () => void;
}

export function AlchemySetup({ onSaved }: Props) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.saveAlchemyKey(key.trim());
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center panel">
      <h2>Connect to Alchemy</h2>

      <div className="warnbox">
        This bot needs an <b>Alchemy API key</b> to read on-chain data and submit
        transactions. Create a free key at{" "}
        <span className="mono">alchemy.com</span>, then paste it below.
        Your key is stored locally and is sent only as part of requests to the
        configured Alchemy endpoints.
      </div>
      <div className="spacer" />

      <label className="field">
        Alchemy API key
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="paste your key here"
          autoFocus
        />
      </label>

      {error && <p className="err">{error}</p>}

      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="primary"
          disabled={busy || key.trim().length < 10}
          onClick={save}
        >
          {busy ? "Saving…" : "Save & continue"}
        </button>
      </div>

      <p className="hint" style={{ marginTop: 12 }}>
        You can change this key later in the Config tab.
      </p>
    </div>
  );
}
