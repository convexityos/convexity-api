"""Unit tests verifying the Convexity Agent Provenance & Freshness Eval Harness."""

from __future__ import annotations

import pathlib
import sys
import unittest

EVALS_DIR = pathlib.Path(__file__).resolve().parent
if str(EVALS_DIR) not in sys.path:
    sys.path.insert(0, str(EVALS_DIR))

from agent_freshness_eval import (  # noqa: E402
    EVAL_CASES,
    evaluate_agent,
    naive_noncompliant_agent,
    reference_compliant_agent,
)


class TestAgentFreshnessEval(unittest.TestCase):
    def test_reference_compliant_agent_passes_all_cases(self) -> None:
        report = evaluate_agent(reference_compliant_agent)
        self.assertEqual(report.total, len(EVAL_CASES))
        self.assertEqual(report.passed, report.total, f"failures: {[r for r in report.results if not r.passed]}")
        self.assertEqual(report.pass_rate, 1.0)

    def test_naive_noncompliant_agent_fails_every_case(self) -> None:
        report = evaluate_agent(naive_noncompliant_agent)
        self.assertEqual(report.passed, 0, f"expected 0 passes for naive agent, got: {report.results}")


if __name__ == "__main__":
    unittest.main()
