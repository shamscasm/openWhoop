"""Tests for the Apple Health (Health Auto Export) ingest endpoint."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from whoof import dashboard


@pytest.fixture
def temp_health_file(monkeypatch):
    """Redirect HEALTH_FILE to a tmp path so tests don't touch real data."""
    tmp = Path(tempfile.mkdtemp()) / "health-latest.json"
    monkeypatch.setattr(dashboard, "HEALTH_FILE", tmp)
    monkeypatch.setattr(dashboard, "DATA_DIR", tmp.parent)
    yield tmp


def test_ingest_handles_nested_hae_payload(temp_health_file):
    """Health Auto Export nests metrics under data.metrics[]."""
    payload = {
        "data": {
            "metrics": [
                {
                    "name": "Body Mass",
                    "units": "kg",
                    "data": [{"qty": 75.5, "date": "2026-05-20 08:00:00 +0000"}],
                }
            ]
        }
    }
    result = dashboard.api_health_ingest(payload)
    assert result["accepted"] == ["weight_kg"]
    assert result["values"]["weight_kg"] == 75.5
    assert "weight_kg_date" in result["values"]
    assert temp_health_file.exists()


def test_ingest_handles_flat_payload(temp_health_file):
    """Older HAE / direct shortcut posts use the flat shape."""
    payload = {
        "name": "Body Mass",
        "units": "kg",
        "data": [{"qty": 72.3, "date": "2026-05-19 10:00:00 +0000"}],
    }
    result = dashboard.api_health_ingest(payload)
    assert result["values"]["weight_kg"] == 72.3


def test_ingest_converts_lbs_to_kg(temp_health_file):
    payload = {
        "name": "Body Mass",
        "units": "lb",
        "data": [{"qty": 165, "date": "2026-05-20"}],
    }
    result = dashboard.api_health_ingest(payload)
    # 165 lb * 0.45359237 ≈ 74.84
    assert abs(result["values"]["weight_kg"] - 74.843) < 0.01


def test_ingest_converts_inches_to_cm(temp_health_file):
    payload = {
        "name": "Height",
        "units": "in",
        "data": [{"qty": 70, "date": "2026-05-20"}],
    }
    result = dashboard.api_health_ingest(payload)
    # 70 in * 2.54 = 177.8
    assert abs(result["values"]["height_cm"] - 177.8) < 0.01


def test_ingest_takes_latest_sample_when_multiple(temp_health_file):
    """If HAE sends multiple samples, we keep the most recent one."""
    payload = {
        "name": "Body Mass",
        "units": "kg",
        "data": [
            {"qty": 70.0, "date": "2026-05-18 08:00:00 +0000"},
            {"qty": 73.0, "date": "2026-05-20 08:00:00 +0000"},
            {"qty": 71.0, "date": "2026-05-19 08:00:00 +0000"},
        ],
    }
    result = dashboard.api_health_ingest(payload)
    assert result["values"]["weight_kg"] == 73.0


def test_ingest_ignores_unknown_metric_names(temp_health_file):
    payload = {
        "name": "Some Random Metric",
        "units": "x",
        "data": [{"qty": 1, "date": "2026-05-20"}],
    }
    result = dashboard.api_health_ingest(payload)
    assert result["accepted"] == []


def test_ingest_merges_with_existing_values(temp_health_file):
    """Subsequent POSTs only update the fields they include."""
    # First POST: weight
    dashboard.api_health_ingest({
        "name": "Body Mass", "units": "kg",
        "data": [{"qty": 75.0, "date": "2026-05-20"}],
    })
    # Second POST: height
    result = dashboard.api_health_ingest({
        "name": "Height", "units": "cm",
        "data": [{"qty": 178.0, "date": "2026-05-20"}],
    })
    # Weight should still be there
    assert result["values"]["weight_kg"] == 75.0
    assert result["values"]["height_cm"] == 178.0


def test_ingest_handles_resting_hr_and_vo2(temp_health_file):
    dashboard.api_health_ingest({
        "data": {"metrics": [
            {"name": "Resting Heart Rate", "units": "bpm",
             "data": [{"qty": 56, "date": "2026-05-20"}]},
            {"name": "VO2 Max", "units": "mL/(kg*min)",
             "data": [{"qty": 48.5, "date": "2026-05-20"}]},
        ]}
    })
    snap = dashboard.api_health_latest()
    assert snap["values"]["resting_hr"] == 56
    assert snap["values"]["vo2_max"] == 48.5


def test_latest_returns_empty_when_no_file(temp_health_file):
    assert temp_health_file.exists() is False
    result = dashboard.api_health_latest()
    assert result == {"values": {}, "updated_at": None}


def test_ingest_robust_to_malformed_payload(temp_health_file):
    """Don't crash if payload is junk."""
    assert dashboard.api_health_ingest({})["accepted"] == []
    assert dashboard.api_health_ingest({"name": "Body Mass"})["accepted"] == []
    assert dashboard.api_health_ingest({
        "name": "Body Mass", "data": [{"qty": "not-a-number", "date": "x"}]
    })["accepted"] == []
