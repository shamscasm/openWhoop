"""Sanity tests for HRV / strain / recovery math on synthetic data."""

from __future__ import annotations

import math
import random
import statistics

from whoof import metrics


def test_filter_rr_drops_ectopic_beats():
    rr = [800, 810, 805, 1300, 800, 795]  # 1300 is an ectopic spike
    out = metrics.filter_rr(rr)
    assert 1300 not in out
    assert len(out) == 5


def test_rmssd_zero_for_constant_intervals():
    rmssd = metrics.rmssd([800] * 30)
    assert rmssd == 0.0 or rmssd < 0.001


def test_rmssd_known_value():
    # Alternating pattern: successive diffs are +10/-10 each beat.
    # Squared diffs are all 100, mean = 100, sqrt(mean) = 10.
    rr = [800, 810, 800, 810, 800, 810, 800, 810, 800, 810]
    rmssd = metrics.rmssd(rr)
    assert rmssd is not None
    assert math.isclose(rmssd, 10.0, rel_tol=1e-9)


def test_rmssd_typical_resting_range():
    # Simulate light Gaussian jitter around a baseline -> RMSSD should be
    # in the 20-80ms range typical of resting adults.
    random.seed(7)
    rr = [int(900 + random.gauss(0, 25)) for _ in range(300)]
    rmssd = metrics.rmssd(rr)
    assert rmssd is not None
    assert 10 < rmssd < 200


def test_sdnn_matches_stdev():
    rr = [800, 820, 790, 810, 800, 815, 795]
    sd = metrics.sdnn(rr)
    assert sd is not None
    assert math.isclose(sd, statistics.pstdev(rr), rel_tol=1e-9)


def test_pnn50_all_above():
    rr = [800, 900, 800, 900, 800, 900]
    val = metrics.pnn50(rr)
    assert val is not None
    assert val == 100.0


def test_pnn50_none_above():
    rr = [800, 810, 820, 830, 840]
    val = metrics.pnn50(rr)
    assert val == 0.0


def test_strain_zero_at_rest():
    # 1 hour at perfect rest HR
    score = metrics.strain_score([60.0] * 3600, age=30, resting_hr=60.0)
    assert score < 1.0


def test_strain_grows_with_intensity():
    # 1 hour at rest vs 1 hour at near-max
    rest = [60.0] * 3600
    hard = [180.0] * 3600
    s_rest = metrics.strain_score(rest, age=30, resting_hr=60.0)
    s_hard = metrics.strain_score(hard, age=30, resting_hr=60.0)
    assert s_hard > s_rest
    assert s_hard <= 21.0


def test_strain_bounded():
    # 6 hours at max HR shouldn't exceed Whoop's 21.
    score = metrics.strain_score([200.0] * 6 * 3600, age=30, resting_hr=50.0)
    assert 0.0 <= score <= 21.0


def test_recovery_score_baseline():
    history = [50.0, 52.0, 48.0, 51.0, 49.0]
    # exactly at the mean -> ~50
    score = metrics.recovery_score(50.0, history)
    assert score is not None
    assert 40 <= score <= 60


def test_recovery_score_high():
    history = [50.0, 52.0, 48.0, 51.0, 49.0]
    score = metrics.recovery_score(100.0, history)
    assert score is not None
    assert score > 80


def test_recovery_score_low():
    history = [50.0, 52.0, 48.0, 51.0, 49.0]
    score = metrics.recovery_score(20.0, history)
    assert score is not None
    assert score < 20


def test_recovery_none_without_history():
    assert metrics.recovery_score(50.0, []) is None
    assert metrics.recovery_score(50.0, [50.0]) is None  # need >= 3
