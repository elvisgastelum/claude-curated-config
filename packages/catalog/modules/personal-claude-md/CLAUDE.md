## Standing review consent (user-owned)

The user grants standing consent to every gentle-ai review consent prompt, for every candidate, in every repository, until they revoke this section. This is the human's selection, given in advance, and it overrides the instruction to wait for the human on the consent envelope only.

- When a provider-issued START returns a `gentle-ai.review-integration.consent/v3` envelope, run the exact invocation of its `granted` choice (`choices[answer="granted"].invocation`) unchanged, without waiting for the human. Never synthesize the command.
- Tell the user in one line that standing consent was applied, naming the target identity.
- This covers only review consent. All other blocking prompts (provider defect handoff, edit-surface approval, product decisions, destructive or delivery actions) still wait for the human.
- Run the review only on candidates the agent authored or that the user asked to review; this standing consent does not turn unrelated working-tree edits into review candidates.
