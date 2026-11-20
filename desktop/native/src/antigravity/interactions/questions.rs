use super::{Target, WAITING, bounded_text, pending_interaction};
use crate::requests::Response;
use anyhow::{Result, bail, ensure};
use serde_json::{Value, json};
use std::collections::HashSet;

pub(super) const ASK_QUESTION: &str = "CORTEX_STEP_TYPE_ASK_QUESTION";
const MAX_OPTIONS: usize = 100;

struct Question<'a> {
    text: &'a str,
    options: Vec<(&'a str, &'a str)>,
    multi_select: bool,
}

pub(super) struct QuestionBatch<'a>(Vec<Question<'a>>);

pub(super) fn asked(step: &Value) -> Option<&Value> {
    if step["type"] != ASK_QUESTION
        || step["completedInteractions"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|done| done["response"]["askQuestion"].is_object())
    {
        return None;
    }
    if pending_interaction(step) {
        return step["requestedInteraction"]["askQuestion"]
            .as_object()
            .map(|_| &step["requestedInteraction"]["askQuestion"]);
    }
    // Some installed LanguageServer builds expose the pending form on the tool step itself.
    (step["status"] == WAITING
        && step["requestedInteraction"]
            .as_object()
            .is_none_or(|request| request.is_empty())
        && step["askQuestion"].is_object())
    .then_some(&step["askQuestion"])
}

impl<'a> QuestionBatch<'a> {
    pub(super) fn read(step: &'a Value) -> Option<Self> {
        Self::from_request(asked(step)?)
    }

    pub(super) fn from_request(ask: &'a Value) -> Option<Self> {
        let items = ask["questions"]
            .as_array()
            .filter(|questions| (1..=20).contains(&questions.len()))?;
        let questions = items
            .iter()
            .map(Question::read)
            .collect::<Option<Vec<_>>>()?;
        if questions.iter().map(Question::size).sum::<usize>() > 100_000 {
            return None;
        }
        Some(Self(questions))
    }

    pub(super) fn view(&self, target: &Target, actionable: bool) -> Value {
        let questions = self.0.iter().enumerate().map(|(index, question)| {
            json!({
                "id": format!("question-{index}"),
                "question": question.text,
                "options": question.options.iter().map(|(_, label)| json!({"label":label,"description":""})).collect::<Vec<_>>(),
                "multiSelect": question.multi_select && !question.options.is_empty(),
            })
        }).collect::<Vec<_>>();
        let native_ids = self
            .0
            .iter()
            .map(|q| q.options.iter().map(|(id, _)| id).collect::<Vec<_>>())
            .collect::<Vec<_>>();
        json!({
            "id": target.id(),
            "kind": "question",
            "title": "Antigravity 需要你的回答",
            "description": "",
            "turnId": target.turn_id,
            "fingerprint": crate::state::hash(&json!([target.trajectory_id, target.step_index, target.turn_id, questions, native_ids]).to_string()),
            "questions": questions,
            "actionable": actionable,
        })
    }

    pub(super) fn reply(&self, shown: &Value, answer: &Response) -> Result<Vec<Value>> {
        let replies = answer.checked_answers_with_limit(shown, MAX_OPTIONS)?;
        self.0
            .iter()
            .zip(replies)
            .map(|(question, (id, values))| question.reply(values, answer.is_write_in(id)))
            .collect()
    }
}

pub(super) fn replies_match(sent: &Value, recorded: &Value) -> bool {
    let (Some(sent), Some(recorded)) = (sent.as_array(), recorded.as_array()) else {
        return false;
    };
    !sent.is_empty()
        && sent.len() == recorded.len()
        && sent.iter().zip(recorded).all(|(sent, recorded)| {
            if !recorded.is_object() {
                return false;
            }
            let Some(selected) = selected_ids(&recorded["selectedOptionIds"]) else {
                return false;
            };
            let Some(written) = write_in(&recorded["writeInResponse"]) else {
                return false;
            };
            Some(selected) == selected_ids(&sent["selectedOptionIds"])
                && Some(written) == write_in(&sent["writeInResponse"])
        })
}

fn selected_ids(value: &Value) -> Option<HashSet<&str>> {
    match value {
        Value::Null => Some(HashSet::new()),
        Value::Array(items) => {
            let ids = items
                .iter()
                .map(Value::as_str)
                .collect::<Option<HashSet<_>>>()?;
            (ids.len() == items.len()).then_some(ids)
        }
        _ => None,
    }
}

fn write_in(value: &Value) -> Option<&str> {
    match value {
        Value::Null => Some(""),
        Value::String(text) => Some(text),
        _ => None,
    }
}

impl<'a> Question<'a> {
    fn read(question: &'a Value) -> Option<Self> {
        let text = bounded_text(&question["question"], 16_000)?;
        let options = match question.get("options") {
            None => Vec::new(),
            Some(options) => {
                let rows = options
                    .as_array()
                    .filter(|options| options.len() <= MAX_OPTIONS)?;
                let mut ids = HashSet::new();
                let mut labels = HashSet::new();
                rows.iter()
                    .map(|row| {
                        let id = bounded_text(&row["id"], 500)?;
                        let label = bounded_text(&row["text"], 4_000)?;
                        // The shared question card submits option labels, so both fields must be distinct.
                        (ids.insert(id) && labels.insert(label)).then_some((id, label))
                    })
                    .collect::<Option<Vec<_>>>()?
            }
        };
        let multi_select = match question.get("isMultiSelect") {
            None => false,
            Some(value) => value.as_bool()?,
        };
        Some(Self {
            text,
            options,
            multi_select,
        })
    }

    fn size(&self) -> usize {
        self.text.len()
            + self
                .options
                .iter()
                .map(|(id, label)| id.len() + label.len())
                .sum::<usize>()
    }

    fn reply(&self, values: &[String], write_in: Option<bool>) -> Result<Value> {
        ensure!(
            self.multi_select || values.len() == 1,
            "此问题只接受一项回答"
        );
        ensure!(
            values.iter().collect::<HashSet<_>>().len() == values.len(),
            "回答选项重复"
        );
        let mut result = json!({
            "question": self.text,
            "options": self.options.iter().map(|(id, text)| json!({"id":id,"text":text})).collect::<Vec<_>>(),
            "isMultiSelect": self.multi_select,
        });
        if write_in == Some(true) {
            let [value] = values else {
                bail!("自定义回答只接受一项答案");
            };
            result["writeInResponse"] = json!(value.trim());
            return Ok(result);
        }
        let selected: Option<Vec<_>> = values
            .iter()
            .map(|value| {
                self.options
                    .iter()
                    .find(|(_, label)| *label == value)
                    .map(|(id, _)| *id)
            })
            .collect();
        match (selected, write_in, values) {
            (Some(selected), _, _) => result["selectedOptionIds"] = json!(selected),
            // Clients without the mode field encode free text as an unmatched label.
            (None, None, [value]) => result["writeInResponse"] = json!(value.trim()),
            _ => bail!("回答选项不在当前问题中"),
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::super::{question_recorded, response, views};
    use super::*;

    fn trajectory() -> Value {
        json!({
            "trajectoryId":"6293a911-d6c7-431f-b108-4dbbf83add30",
            "cascadeId":"56416701-464d-4880-9262-5dbd91cf2a8e",
            "steps":[{
                "type":ASK_QUESTION,
                "status":WAITING,
                "metadata":{"executionId":"fixture-turn"},
                "askQuestion":{"questions":[
                    {"question":"选择一个", "options":[{"id":"yes","text":"同意"},{"id":"no","text":"不同意"}]},
                    {"question":"选择多个", "isMultiSelect":true,"options":[{"id":"one","text":"一"},{"id":"two","text":"二"}]},
                    {"question":"自行填写","isMultiSelect":true}
                ]}
            }]
        })
    }

    fn reply(shown: &Value, answers: Value) -> Response {
        serde_json::from_value(answer_body(shown, answers)).unwrap()
    }

    fn answer_body(shown: &Value, answers: Value) -> Value {
        json!({
            "requestId":"09ce9c86-c98c-4a52-9c77-18bb54d8c770",
            "targetRequestId":shown["id"],
            "expectedTurnId":shown["turnId"],
            "expectedFingerprint":shown["fingerprint"],
            "answers":answers,
        })
    }

    #[test]
    fn answer_receipt_requires_the_same_target_question_and_answer() {
        let trajectory = trajectory();
        let shown = &views(&trajectory, false)[0];
        let answer = reply(
            shown,
            json!({"question-0":["同意"],"question-1":["一","二"],"question-2":["手填"]}),
        );
        let sent = response(&trajectory, &answer).unwrap();
        let mut step = trajectory["steps"][0].clone();
        let mut receipt = sent.clone();
        // Native JSON omits default fields and can record selected options in a different order.
        receipt.as_object_mut().unwrap().remove("stepIndex");
        let rows = receipt["askQuestion"]["responses"].as_array_mut().unwrap();
        rows[0].as_object_mut().unwrap().remove("isMultiSelect");
        rows[1]["selectedOptionIds"]
            .as_array_mut()
            .unwrap()
            .reverse();
        step["status"] = json!("CORTEX_STEP_STATUS_DONE");
        step["completedInteractions"] = json!([{
            "request":{"askQuestion":step["askQuestion"]},"response":receipt,
        }]);
        let confirms = |step: &Value| {
            question_recorded(
                trajectory["cascadeId"].as_str().unwrap(),
                trajectory["trajectoryId"].as_str().unwrap(),
                0,
                step,
                &sent,
                &answer,
            )
        };
        assert!(confirms(&step));

        let mut changed = step.clone();
        changed["completedInteractions"][0]["response"]["askQuestion"]["responses"][0] =
            json!({"writeInResponse":"同意"});
        assert!(!confirms(&changed));
        let mut changed = step.clone();
        changed["completedInteractions"][0]["request"]["askQuestion"]["questions"][0]["question"] =
            json!("其他问题");
        assert!(!confirms(&changed));
        let mut changed = step.clone();
        changed["completedInteractions"][0]["response"]["stepIndex"] = json!(1);
        assert!(!confirms(&changed));
        let mut changed = step.clone();
        changed["metadata"]["executionId"] = json!("different-turn");
        assert!(!confirms(&changed));
        step["completedInteractions"] = Value::Null;
        assert!(!confirms(&step));
    }

    #[test]
    fn native_questions_map_single_multiple_and_written_answers() {
        let trajectory = trajectory();
        let shown = &views(&trajectory, false)[0];
        assert_eq!(shown["kind"], "question");
        assert_eq!(shown["actionable"], true);
        assert_eq!(shown["questions"][1]["multiSelect"], true);
        assert_eq!(shown["questions"][2]["multiSelect"], false);
        assert_eq!(views(&trajectory, true)[0]["actionable"], false);
        let answer = reply(
            shown,
            json!({"question-0":["同意"],"question-1":["一","二"],"question-2":["自定义答案"]}),
        );
        assert!(
            serde_json::to_value(&answer)
                .unwrap()
                .get("writeInQuestionIds")
                .is_none()
        );
        let outbound = response(&trajectory, &answer).unwrap();
        assert_eq!(outbound["trajectoryId"], trajectory["trajectoryId"]);
        assert_eq!(outbound["stepIndex"], 0);
        assert_eq!(
            outbound["askQuestion"]["responses"][0]["selectedOptionIds"],
            json!(["yes"])
        );
        assert_eq!(
            outbound["askQuestion"]["responses"][1]["selectedOptionIds"],
            json!(["one", "two"])
        );
        assert_eq!(
            outbound["askQuestion"]["responses"][2]["writeInResponse"],
            "自定义答案"
        );
    }

    #[test]
    fn explicit_write_in_preserves_matching_option_text() {
        let trajectory = trajectory();
        let shown = &views(&trajectory, false)[0];
        let mut body = answer_body(
            shown,
            json!({"question-0":["同意"],"question-1":["一"],"question-2":["自定义答案"]}),
        );
        body["writeInQuestionIds"] = json!(["question-0", "question-2"]);
        let answer = serde_json::from_value(body.clone()).unwrap();
        let outbound = response(&trajectory, &answer).unwrap();
        let answers = &outbound["askQuestion"]["responses"];
        assert_eq!(answers[0]["writeInResponse"], "同意");
        assert!(answers[0].get("selectedOptionIds").is_none());
        assert_eq!(answers[1]["selectedOptionIds"], json!(["one"]));
        assert_eq!(answers[2]["writeInResponse"], "自定义答案");

        for ids in [
            json!(["question-0", "question-0"]),
            json!(["question-2", "nonexistent"]),
            json!([]),
        ] {
            body["writeInQuestionIds"] = ids;
            let answer = serde_json::from_value(body.clone()).unwrap();
            assert!(response(&trajectory, &answer).is_err());
        }
    }

    #[test]
    fn native_multi_select_accepts_every_displayed_option() {
        let mut trajectory = trajectory();
        let options: Vec<_> = (0..MAX_OPTIONS)
            .map(|index| json!({"id":format!("native-{index}"),"text":format!("Option {index}")}))
            .collect();
        trajectory["steps"][0]["askQuestion"]["questions"][1]["options"] = json!(options);
        let shown = &views(&trajectory, false)[0];
        let selected: Vec<_> = options.iter().map(|option| &option["text"]).collect();
        let native_ids: Vec<_> = options.iter().map(|option| &option["id"]).collect();
        let mut body = answer_body(
            shown,
            json!({"question-0":["同意"],"question-1":selected,"question-2":["自定义答案"]}),
        );
        body["writeInQuestionIds"] = json!(["question-2"]);
        let answer = serde_json::from_value(body.clone()).unwrap();
        let outbound = response(&trajectory, &answer).unwrap();
        assert_eq!(
            outbound["askQuestion"]["responses"][1]["selectedOptionIds"],
            json!(native_ids)
        );

        body["answers"]["question-1"]
            .as_array_mut()
            .unwrap()
            .push(json!("extra"));
        assert!(response(&trajectory, &serde_json::from_value(body).unwrap()).is_err());
    }

    #[test]
    fn answer_requires_current_question_turn_options_and_target_trajectory() {
        let mut trajectory = trajectory();
        let shown = &views(&trajectory, false)[0];
        let answer = reply(
            shown,
            json!({"question-0":["同意"],"question-1":["一"],"question-2":["自定义答案"]}),
        );
        let bad = reply(
            shown,
            json!({"question-0":["同意","不同意"],"question-1":["一"],"question-2":["自定义答案"]}),
        );
        assert!(response(&trajectory, &bad).is_err());
        trajectory["steps"][0]["askQuestion"]["questions"][0]["options"][0]["id"] =
            json!("updated");
        assert!(response(&trajectory, &answer).is_err());
        trajectory["steps"][0]["metadata"]["sourceTrajectoryStepInfo"]["trajectoryId"] =
            json!("another-trajectory");
        assert_eq!(views(&trajectory, false)[0]["kind"], "unsupported");
    }

    #[test]
    fn native_completion_removes_direct_and_explicit_questions() {
        let mut trajectory = trajectory();
        let question = trajectory["steps"][0]["askQuestion"].clone();
        trajectory["steps"][0]["requestedInteraction"]["askQuestion"] = question.clone();
        assert_eq!(views(&trajectory, false)[0]["kind"], "question");
        trajectory["steps"][0]["completedInteractions"] = json!([{"request":{"askQuestion":question},"response":{"askQuestion":{"responses":[]}}}]);
        assert!(views(&trajectory, false).is_empty());
    }
}
