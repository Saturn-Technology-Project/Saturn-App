---
name: fine-tuning
description: Supervised fine-tuning of a checkpoint on instruction data, with a fair before-and-after. Read when doing SFT.
---
# Supervised fine-tuning

## Set up
- Parent: the exact checkpoint, as a pinned model record.
- Data: a prompt and response per example, with its template fixed. Record its name in `trainingData` on the model it produces.
- Before training, evaluate the parent with the evaluation you will use after. Otherwise there is no comparison.

## The loss
Cross-entropy on the response only. Set `labels` to `-100` on the prompt and on padding:
```python
prompt_ids = tokenizer(prompt, add_special_tokens=False).input_ids
answer_ids = tokenizer(answer + tokenizer.eos_token, add_special_tokens=False).input_ids
input_ids = prompt_ids + answer_ids
labels = [-100] * len(prompt_ids) + answer_ids
```
Read `tokenizer-and-format` first. Include EOS, or the model never stops.

## Settings to start from
- Learning rate from 1e-5 to 5e-5: much lower than pretraining. Too high destroys what the parent knew.
- One to three epochs. Validate often, and keep the best by validation.
- Small batches on small devices, with gradient accumulation to reach an effective batch.
- `peft` for LoRA when memory is short, on the `training` kit. Merge before evaluating or looking inside, since helpers load plain weights.

## Check for damage
Measure what the parent could do, as well as the target skill. Fine-tuning often trades one for the other. Include the general evaluation next to the target one, and report both.

## Record
Model record: `parentId` the parent, `trainingData`, `producedBy` the run. Compare with `comparing-across-lineage`. The experiment that trains and the experiment that evaluates are separate experiments, so evaluation stays unchanged.
