import math
from dataclasses import dataclass, field
from typing import List

@dataclass
class RadarTarget:
    """
    A point-scatterer in the radar scene.
    Coordinate convention  (North-up, right-hand):
        x_m  – East component
        y_m  – North component
    """
    target_id:    str
    x_m:          float
    y_m:          float
    velocity_m_s: float = 0.0
    rcs_sqm:      float = 1.0

    @property
    def range_m(self) -> float:
        """Slant range from the radar origin to this target (metres)."""
        return math.sqrt(self.x_m ** 2 + self.y_m ** 2)

    @property
    def bearing_deg(self) -> float:
        """True bearing from radar origin, clockwise from North (degrees)."""
        return math.degrees(math.atan2(self.x_m, self.y_m))

    @property
    def rcs_db(self) -> float:
        """RCS expressed in dBsm (dB relative to 1 m²)."""
        return 10.0 * math.log10(max(self.rcs_sqm, 1e-9))


@dataclass
class RadarEnvironment:
    """
    Describes the electromagnetic environment the radar operates in.
    """
    targets:           List[RadarTarget] = field(default_factory=list)
    noise_floor_dbm:   float = -100.0
    clutter_floor_dbm: float = -200.0    # disabled by default
    clutter_range_exp: float = -20.0     # dB / decade

    def noise_plus_clutter_dbm(self, range_m: float) -> float:
        """Effective interference floor (thermal noise + clutter) at `range_m`."""
        range_m = max(range_m, 1.0)
        clutter_dbm = (
            self.clutter_floor_dbm
            + self.clutter_range_exp * (10.0 * math.log10(range_m / 1_000.0))
        )
        n_lin  = 10.0 ** (self.noise_floor_dbm / 10.0)
        c_lin  = 10.0 ** (clutter_dbm / 10.0)
        return 10.0 * math.log10(max(n_lin + c_lin, 1e-30))

    def add_target(self, target: RadarTarget) -> None:
        self.targets.append(target)

    def remove_target(self, target_id: str) -> bool:
        before = len(self.targets)
        self.targets = [t for t in self.targets if t.target_id != target_id]
        return len(self.targets) < before

    def update_target(self, target_id: str, **kwargs) -> bool:
        for t in self.targets:
            if t.target_id == target_id:
                for key, value in kwargs.items():
                    if hasattr(t, key):
                        setattr(t, key, value)
                return True
        return False