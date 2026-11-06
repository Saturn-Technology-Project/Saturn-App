---
name: tokenizer-and-format
description: Avoid tokenizer, padding, chat template and label-masking mistakes. Read before training or evaluating a language model.
---
# Tokenizer and prompt format

These bugs train without errors and quietly ruin results.

## Check by printing
Decode a real batch after collation, and read it. Print `input_ids`, `attention_mask` and `labels` side by side for one example.

## Common mistakes
- **Padding side**: for generation with batches, pad left. For training, right is usual. Set `tokenizer.padding_side` deliberately. Reading the last token's logits with right padding reads a pad token.
- **No pad token**: GPT-style tokenizers have none. `tokenizer.pad_token = tokenizer.eos_token` is common, and then mask pads by attention mask, not by token id.
- **Labels**: for causal language models, `labels` are shifted inside the model. Set ignored positions to `-100`: padding, and the prompt in supervised fine-tuning. Do not shift them yourself as well.
- **BOS and EOS**: check whether the tokenizer adds BOS, and whether a template already did. Double BOS is common. Train with EOS, or the model never learns to stop.
- **Leading spaces**: `" Mary"` and `"Mary"` are different tokens. For logit comparisons, check each name is one token with the leading space you mean.
- **Chat templates**: use `tokenizer.apply_chat_template`. Set `add_generation_prompt=True` for generation. Train and evaluate with the same template.
- **Truncation**: count how many examples are cut. Truncating the answer ruins supervised training.

## In the evaluation
`promptFormat` and `chatTemplate` are part of `evaluation`, and changing them makes runs `not_comparable`. That is correct: a different format is a different measurement. Base models take continuations and chat models take templates, so compare across that only with care, and say so.
