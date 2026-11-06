//! A run's recordings: only folders of Saturn's own count, whatever a tool result says.
use std::path::Path;
use std::sync::Arc;

use saturn_core::Kernel;
use saturn_store::key_store::{KeyStoreName, key_store};
use saturn_store::{FileStore, SecretsFile};
use serde_json::json;

/// A step that says it recorded into `folder`.
fn stopped(id: &str, folder: &Path) -> serde_json::Value {
    json!({ "id": id, "toolId": "browser_record_stop", "arguments": {}, "status": "completed", "result": { "recording": folder, "frames": 1, "seconds": 0.3 } })
}

#[tokio::test]
async fn a_runs_recordings_are_saturns_own_folders_and_frames_are_found_by_index() {
    let data = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let root = data.path().to_path_buf();
    let secrets = SecretsFile::with_preferred(
        data.path(),
        Box::new(move || key_store(KeyStoreName::File, &root)),
    );
    let store = Arc::new(FileStore::load_with(data.path(), secrets).await.unwrap());
    let kernel = Kernel::new(Arc::clone(&store)).unwrap();
    let recordings = data.path().join("workspace/recordings");
    let folder = recordings.join("demo");
    std::fs::create_dir_all(&folder).unwrap();
    for index in 1..=3 {
        std::fs::write(folder.join(format!("frame-0000{index}.jpg")), [0xff, 0xd8]).unwrap();
    }
    std::fs::write(folder.join("frames.txt"), "not a frame").unwrap();
    std::fs::create_dir_all(recordings.join("deeper/inside")).unwrap();
    let mut failed = stopped("a7", &folder);
    failed["status"] = "failed".into();
    let actions = json!([
        stopped("a1", &folder),
        stopped("a2", &folder),
        stopped("a3", elsewhere.path()),
        stopped("a4", &recordings.join("../../secrets.json")),
        stopped("a5", &recordings.join("../..")),
        stopped("a6", &recordings.join("deeper/inside")),
        failed,
    ]);
    store
        .update(|state| {
            state.runs.insert(0, json!({ "id": "run_rec", "agentId": "agt", "input": "record", "status": "completed", "output": "", "generation": 0, "actions": actions }));
        })
        .await
        .unwrap();
    assert_eq!(
        kernel.recordings("run_rec").unwrap(),
        vec![json!({ "name": "demo", "frames": 3, "seconds": 0.3, "exported": false })]
    );
    assert_eq!(
        kernel.recording_frame("run_rec", "demo", "2").unwrap(),
        folder.join("frame-00002.jpg")
    );
    for index in ["0", "4", "nope", "1.5", "-1", "../../secrets.json"] {
        assert_eq!(
            kernel
                .recording_frame("run_rec", "demo", index)
                .unwrap_err()
                .status,
            404,
            "{index}"
        );
    }
    assert_eq!(
        kernel
            .recording_frame("run_rec", "..", "1")
            .unwrap_err()
            .status,
        404
    );
    assert_eq!(
        kernel
            .recording_frame("run_rec", "other", "1")
            .unwrap_err()
            .status,
        404
    );
}
