import React, { useState, useCallback, useEffect, useRef } from "react";

const API_BASE = "/api";

function formatBytes(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function UploadForm({ onJobCreated }) {
  const [file, setFile] = useState(null);
  const [resolution, setResolution] = useState("720p");
  const [speed, setSpeed] = useState("1");
  const [fps, setFps] = useState("15");
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const resMap = { "720p": { w: 1280, h: 720 }, "1080p": { w: 1920, h: 1080 } };

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith(".json")) {
      setFile(f);
      setError(null);
    } else {
      setError("Please drop a .json file");
    }
  }, []);

  const handleFileChange = (e) => {
    const f = e.target.files[0];
    if (f) {
      setFile(f);
      setError(null);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) return;

    setUploading(true);
    setError(null);

    try {
      const { w, h } = resMap[resolution];
      const params = new URLSearchParams({
        width: w,
        height: h,
        fps,
        speed,
      });

      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`${API_BASE}/jobs?${params}`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Upload failed (${res.status})`);
      }

      const data = await res.json();
      onJobCreated(data.jobId);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="upload-form">
      <div
        className={`drop-zone ${dragOver ? "drag-over" : ""} ${file ? "has-file" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileChange}
          hidden
        />
        {file ? (
          <div className="file-info">
            <span className="file-icon">&#128196;</span>
            <span className="file-name">{file.name}</span>
            <span className="file-size">({formatBytes(file.size)})</span>
          </div>
        ) : (
          <div className="drop-prompt">
            <span className="upload-icon">&#8686;</span>
            <p>Drop rrweb JSON file here or click to browse</p>
          </div>
        )}
      </div>

      <div className="settings-panel">
        <div className="setting">
          <label htmlFor="resolution">Resolution</label>
          <select id="resolution" value={resolution} onChange={(e) => setResolution(e.target.value)}>
            <option value="720p">720p (1280x720)</option>
            <option value="1080p">1080p (1920x1080)</option>
          </select>
          <span className="setting-help">Output video dimensions</span>
        </div>
        <div className="setting">
          <label htmlFor="speed">Speed</label>
          <select id="speed" value={speed} onChange={(e) => setSpeed(e.target.value)}>
            <option value="1">1x</option>
            <option value="2">2x</option>
            <option value="4">4x</option>
          </select>
          <span className="setting-help">
            Playback rate. 2x = half length, 4x = quarter length.
          </span>
        </div>
        <div className="setting">
          <label htmlFor="fps">FPS</label>
          <select id="fps" value={fps} onChange={(e) => setFps(e.target.value)}>
            <option value="10">10</option>
            <option value="15">15</option>
            <option value="30">30</option>
          </select>
          <span className="setting-help">Frames per second</span>
        </div>
      </div>

      {error && <div className="error-msg">{error}</div>}

      <button type="submit" disabled={!file || uploading} className="btn btn-primary">
        {uploading ? "Uploading..." : "Convert to Video"}
      </button>
    </form>
  );
}

function ProcessingView({ jobId, onDone, onError }) {
  const [status, setStatus] = useState("queued");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      while (active) {
        try {
          const res = await fetch(`${API_BASE}/jobs/${jobId}`);
          if (!res.ok) throw new Error("Failed to fetch status");
          const data = await res.json();

          if (!active) return;

          setStatus(data.status);
          setProgress(data.progress || 0);

          if (data.status === "done") {
            onDone(data);
            return;
          }
          if (data.status === "failed") {
            onError(data.error || "Conversion failed");
            return;
          }
        } catch (err) {
          console.error("Polling error:", err);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };

    poll();
    return () => { active = false; };
  }, [jobId, onDone, onError]);

  const statusText = {
    queued: "Waiting in queue...",
    processing: "Converting recording to video...",
  };

  return (
    <div className="processing-view">
      <div className="spinner"></div>
      <h2>{statusText[status] || "Processing..."}</h2>
      <p className="job-id">Job: {jobId}</p>
      {status === "processing" && (
        <div className="progress-bar-container">
          <div className="progress-bar" style={{ width: `${progress}%` }}></div>
          <span className="progress-text">{progress}%</span>
        </div>
      )}
    </div>
  );
}

function DoneView({ jobId, jobData, onReset }) {
  const downloadUrl = `${API_BASE}/jobs/${jobId}/download`;

  return (
    <div className="done-view">
      <h2>Conversion Complete</h2>
      {jobData.fileSize && (
        <p className="file-size-info">File size: {formatBytes(jobData.fileSize)}</p>
      )}
      <div className="video-preview">
        <video controls width="100%" src={downloadUrl}>
          Your browser does not support the video tag.
        </video>
      </div>
      <div className="done-actions">
        <a href={downloadUrl} download className="btn btn-primary">
          Download MP4
        </a>
        <button onClick={onReset} className="btn btn-secondary">
          Convert Another
        </button>
      </div>
    </div>
  );
}

function ErrorView({ message, onRetry }) {
  return (
    <div className="error-view">
      <div className="error-icon">&#9888;</div>
      <h2>Conversion Failed</h2>
      <p className="error-detail">{message}</p>
      <button onClick={onRetry} className="btn btn-primary">
        Try Again
      </button>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState("upload"); // upload | processing | done | error
  const [jobId, setJobId] = useState(null);
  const [jobData, setJobData] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const handleJobCreated = (id) => {
    setJobId(id);
    setView("processing");
  };

  const handleDone = useCallback((data) => {
    setJobData(data);
    setView("done");
  }, []);

  const handleError = useCallback((msg) => {
    setErrorMsg(msg);
    setView("error");
  }, []);

  const handleReset = () => {
    setView("upload");
    setJobId(null);
    setJobData(null);
    setErrorMsg(null);
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>rrweb Video Converter</h1>
        <p className="subtitle">Convert rrweb session recordings to MP4 videos</p>
      </header>

      <main className="app-main">
        {view === "upload" && <UploadForm onJobCreated={handleJobCreated} />}
        {view === "processing" && (
          <ProcessingView jobId={jobId} onDone={handleDone} onError={handleError} />
        )}
        {view === "done" && (
          <DoneView jobId={jobId} jobData={jobData} onReset={handleReset} />
        )}
        {view === "error" && (
          <ErrorView message={errorMsg} onRetry={handleReset} />
        )}
      </main>
    </div>
  );
}
