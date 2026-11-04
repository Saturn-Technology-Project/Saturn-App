//! The built-in model, where it is on disk (SATURN_MODELS_DIR); the packaged app ships it.
use saturn_embed::{DEFAULT_BUILTIN_MODEL, EmbedKind, OnnxEmbedder, builtin_model, model_dir};

#[tokio::test(flavor = "multi_thread")]
async fn the_builtin_model_finds_the_english_code_a_chinese_question_is_about() {
    let data = tempfile::tempdir().unwrap();
    if !model_dir(data.path(), DEFAULT_BUILTIN_MODEL).1 {
        eprintln!(
            "skipped: the built-in embedding model is not on this machine (set SATURN_MODELS_DIR)"
        );
        return;
    }
    let model = builtin_model(DEFAULT_BUILTIN_MODEL).unwrap();
    let embedder = OnnxEmbedder::new(data.path().to_path_buf(), model);
    let code: Vec<String> = [
        "function parseImages(raw) { /* checks attached images: data URLs, known types, size limit */ }",
        "export async function projectRules(root) { /* reads AGENTS.md and .cursorrules into the prompt */ }",
        "class CheckpointService { revert(runId) { /* restore the original bytes of files an agent changed */ } }",
        "function cosine(a, b) { /* similarity between two vectors */ }",
    ]
    .map(str::to_owned)
    .to_vec();
    let passages = saturn_embed::Embedder::Builtin(std::sync::Arc::new(embedder));
    let vectors = passages.embed(&code, EmbedKind::Passage).await.unwrap();
    assert_eq!(vectors[0].len(), 384);
    let mut best = Vec::new();
    for question in [
        "還原 agent 改過的檔案",
        "讀取專案規則",
        "檢查使用者附加的圖片大小",
        "向量相似度",
    ] {
        let query = passages
            .embed(&[question.to_owned()], EmbedKind::Query)
            .await
            .unwrap()
            .remove(0);
        let scores: Vec<f32> = vectors
            .iter()
            .map(|vector| vector.iter().zip(&query).map(|(a, b)| a * b).sum())
            .collect();
        let top = (0..scores.len())
            .max_by(|a, b| scores[*a].total_cmp(&scores[*b]))
            .unwrap();
        best.push(top);
    }
    assert_eq!(best, [2, 1, 0, 3]);
}

/// The vectors ONNX Runtime gave in the TypeScript runtime: an index built there has to keep meaning the same here.
#[tokio::test(flavor = "multi_thread")]
async fn the_builtin_model_gives_the_vectors_onnx_runtime_gave() {
    let data = tempfile::tempdir().unwrap();
    if !model_dir(data.path(), DEFAULT_BUILTIN_MODEL).1 {
        eprintln!(
            "skipped: the built-in embedding model is not on this machine (set SATURN_MODELS_DIR)"
        );
        return;
    }
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../../../contract/cases/embeddings.json")).unwrap();
    let embedder = saturn_embed::Embedder::Builtin(std::sync::Arc::new(OnnxEmbedder::new(
        data.path().to_path_buf(),
        builtin_model(DEFAULT_BUILTIN_MODEL).unwrap(),
    )));
    let expected = |list: &str| -> Vec<(String, Vec<f64>)> {
        cases[list]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                let vector = item["vector"].as_array().unwrap();
                (
                    item["text"].as_str().unwrap().to_owned(),
                    vector.iter().map(|value| value.as_f64().unwrap()).collect(),
                )
            })
            .collect()
    };
    let long_text = format!("export const value = {}", "token ".repeat(700));
    let groups = [
        ("passages", EmbedKind::Passage, expected("passages")),
        ("queries", EmbedKind::Query, expected("queries")),
        ("long", EmbedKind::Passage, expected("long")),
    ];
    for (list, kind, items) in groups {
        let texts: Vec<String> = items
            .iter()
            .map(|(text, _)| {
                if text == "LONG" {
                    long_text.clone()
                } else {
                    text.clone()
                }
            })
            .collect();
        let vectors = embedder.embed(&texts, kind).await.unwrap();
        for ((text, wanted), vector) in items.iter().zip(&vectors) {
            let dot: f64 = wanted
                .iter()
                .zip(vector)
                .map(|(a, b)| a * f64::from(*b))
                .sum();
            // This model quantizes by the values of the whole batch, so ONNX Runtime itself differs by this much for one
            // text in another batch (0.9962 to 0.9971 when measured); one text alone comes out the same.
            assert!(dot > 0.996, "{list} {text}: cosine {dot}");
        }
    }
}
