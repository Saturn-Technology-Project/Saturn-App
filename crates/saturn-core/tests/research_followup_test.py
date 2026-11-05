"""Research-script checks with tiny random GPT-NeoX models, no downloads or credentials.

Run with a research Python that has torch/transformers:
python crates/saturn-core/tests/research_followup_test.py
"""
import copy
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

import torch
from transformers import GPTNeoXConfig, GPTNeoXForCausalLM
from transformers.tokenization_utils_base import BatchEncoding

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("followup", ROOT / "scripts/research/name_tracking_followup.py")
followup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(followup)
HELPER_SPEC = importlib.util.spec_from_file_location("inside", ROOT / "crates/saturn-core/src/research/inside.py")
inside = importlib.util.module_from_spec(HELPER_SPEC)
with patch.object(sys, "argv", ["inside.py", "{}"]):
    HELPER_SPEC.loader.exec_module(inside)


class TinyTokenizer:
    """A prompt and one expected token for the helper; the model still performs real tensor computation."""

    def __call__(self, text, **options):
        if "return_tensors" in options:
            return BatchEncoding({"input_ids": torch.tensor([[1, 2, 3, 4]])})
        return BatchEncoding({"input_ids": [3]})

    def decode(self, token):
        return str(int(token[0] if isinstance(token, list) else token))


class ResearchFollowupTests(unittest.TestCase):
    """Checks the intervention's causal position and the distinction between the two success criteria."""

    def setUp(self):
        torch.manual_seed(7)
        torch.set_num_threads(1)
        self.model = GPTNeoXForCausalLM(GPTNeoXConfig(
            vocab_size=32, hidden_size=16, intermediate_size=32, num_hidden_layers=2,
            num_attention_heads=4, max_position_embeddings=32, rotary_pct=0.5,
            attn_implementation="eager",
        )).eval()
        # Learned affine parameters make applying the final norm twice observably different.
        with torch.no_grad():
            self.model.gpt_neox.final_layer_norm.weight.copy_(torch.linspace(0.5, 2.0, 16))
            self.model.gpt_neox.final_layer_norm.bias.copy_(torch.linspace(-0.2, 0.3, 16))
        self.encoded = {"input_ids": torch.tensor([[1, 2, 3, 4]]), "attention_mask": torch.ones(1, 4, dtype=torch.long)}

    def test_self_patch_is_identity_including_last_block_and_embedding(self):
        logits, states = followup.capture(self.model, self.encoded)
        for layer in range(2):
            followup.check_same(followup.transplant(self.model, self.encoded, layer, states[layer]), logits, str(layer))
        with torch.inference_mode():
            embeddings = self.model.get_input_embeddings()(self.encoded["input_ids"])
            followup.check_same(followup.embedding_logits(self.model, self.encoded, embeddings), logits, "embedding")

    def test_last_block_prefix_transfer_reproduces_source_with_shared_norm_and_head(self):
        source = copy.deepcopy(self.model)
        with torch.no_grad():
            source.gpt_neox.embed_in.weight.add_(torch.randn_like(source.gpt_neox.embed_in.weight) * 0.2)
        logits, states = followup.capture(source, self.encoded)
        followup.check_same(followup.transplant(self.model, self.encoded, 1, states[1]), logits, "source prefix")
        with torch.inference_mode():
            normalized = source.gpt_neox.final_layer_norm(states[1])
            wrong = followup.transplant(self.model, self.encoded, 1, normalized)
        self.assertGreater(float((wrong - logits).abs().max()), 1e-3)

    def test_candidate_margin_can_succeed_when_top_one_is_another_word(self):
        class Tokenizer:
            def decode(self, ids):
                return str(ids[0])

        result = followup.metric(Tokenizer(), torch.tensor([3.0, 2.0, 1.0]), (1, 2))
        self.assertTrue(result["correct"])
        self.assertFalse(result["topCorrect"])
        self.assertEqual(result["margin"], 1.0)

    def test_prompt_parser_refuses_different_expected_or_giver(self):
        row = {"sampleId": "s", "input": "When Laura and David went to the store, David gave a drink to", "expected": " Laura"}
        self.assertEqual(followup.sample_names(row), (" Laura", " David"))
        with self.assertRaises(ValueError):
            followup.sample_names({**row, "expected": " David"})
        with self.assertRaises(ValueError):
            followup.sample_names({**row, "input": row["input"].replace(", David", ", Laura")})

    def test_runtime_helper_self_sweep_is_identity_at_every_block(self):
        tokenizer = TinyTokenizer()
        request = {"modelId": "target", "sweep": {"source": {}, "modelId": "target", "samples": [{"sampleId": "s", "input": "prompt", "expected": " wanted"}]}}
        printed = io.StringIO()
        with patch.object(inside, "load", return_value=(tokenizer, self.model)), contextlib.redirect_stdout(printed):
            inside.sweep(tokenizer, self.model, request)
        sample = json.loads(printed.getvalue())["samples"][0]
        for layer in sample["byLayer"]:
            self.assertEqual(layer["top"], sample["top"])
            self.assertAlmostEqual(layer["expectedLogProb"], sample["expectedLogProb"], places=3)

    def test_runtime_helper_final_reading_matches_the_actual_output_distribution(self):
        with torch.no_grad():
            result = self.model(**self.encoded, output_hidden_states=True)
            expected = torch.log_softmax(result.logits[0], dim=-1)[:, 3]
            reading = inside.read(TinyTokenizer(), self.model, result.hidden_states, 3)
        for actual, value in zip(reading[-1]["values"], expected.tolist(), strict=True):
            self.assertAlmostEqual(actual, value, places=3)


if __name__ == "__main__":
    unittest.main()
