---
name: scoping-a-question
description: Turn a broad interest into one answerable research question. Read at the start of a study.
---
# Scoping a question

A good question can be answered by a run you can afford, and could come out either way.

## Test it
1. **Answerable**: what result would answer it? If you cannot picture the table, it is too vague.
2. **Could go either way**: if every outcome is obvious in advance, it teaches nothing. If no outcome would change anyone's mind, drop it.
3. **Affordable**: estimate the compute. See `compute-budget`. Shrink the model, data or sample before shrinking the rigor.
4. **Measurable**: name the score. If it cannot be measured on held-out data, it is not yet a question.
5. **Narrow**: one model family, one behavior, one contrast.

## Shrinking
| Too broad | Better |
|---|---|
| Does fine-tuning make models safer? | Does this SFT set reduce refusals of benign prompts on model X, on this held-out set of 500? |
| How do models track names? | At which layer does patching from a late checkpoint restore name tracking in an early one? |
| Is my training any good? | Does cosine decay reach a lower validation loss than constant learning rate at the same step count? |

## Record it
```
research_write { collection: "questions", fields: { title: "..." } }
```
Put what is out of scope in the first finding. Then read `writing-hypotheses`.

## When to ask the person
The question decides what the study is worth. If the request allows very different questions, propose your narrowed one and say why, before spending any compute.
