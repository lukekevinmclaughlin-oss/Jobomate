import React, { useEffect, useCallback } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { Server, Wifi, WifiOff } from 'lucide-react';

export const LLMStatus: React.FC = () => {
  const { settings, llmStatus, setLlmStatus } = useSettingsStore();

  const checkStatus = useCallback(async () => {
    try {
      const status = await window.browserAPI?.llmServer.getStatus();
      const port = status?.port || settings.llmServerPort || 9222;
      const resp = await fetch('http://127.0.0.1:' + port + '/health');
      if (resp.ok) {
        const data = await resp.json();
        setLlmStatus({ running: true, port: data.port || port, connections: data.connections || 0 });
      } else {
        setLlmStatus({ running: false, port });
      }
    } catch {
      setLlmStatus({ running: false });
    }
  }, [setLlmStatus, settings.llmServerPort]);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 10000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  const toggleServer = async () => {
    try {
      if (llmStatus.running) {
        await window.browserAPI?.llmServer.stop();
      } else {
        await window.browserAPI?.llmServer.start(settings.llmServerPort);
      }
      await checkStatus();
    } catch {}
  };

  return (
    <div className="llm-status">
      <button
        className="llm-status__indicator"
        onClick={toggleServer}
        title={
          llmStatus.running
            ? 'LLM server running on port ' + llmStatus.port + ' (click to stop)'
            : 'LLM server stopped (click to start)'
        }
      >
        <Server size={14} />
        {llmStatus.running ? (
          <Wifi size={10} className="llm-status__icon--online" />
        ) : (
          <WifiOff size={10} className="llm-status__icon--offline" />
        )}
      </button>
      <span className="llm-status__label">
        {llmStatus.running ? 'Jobomate :' + llmStatus.port : 'Bridge Off'}
      </span>
    </div>
  );
};
