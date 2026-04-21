import sys
import os

# 1. FIX THE IMPORT ERROR: Add the parent directory to Python's path
# This allows python to find the "Objects" folder.
parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(parent_dir)

from matplotlib import pyplot as plt
import numpy as np

from Objects.ArrayConfig import ArrayConfig, ProbeElement
from Objects.Physics.PulseEchoEngine import PulseEchoEngine
from Objects.Physics.DynamicEnviroment import DynamicEnvironment, MovingScatterer
from Objects.Physics.TargetEnviroment import Scatterer
from Objects.Scenarios.Ultrasound_Scenario import UltrasoundScenario

print("Simulating physics...")

# --- 1. Init Config ---
NUM_ELEMENTS = 32
elements_list = []
for i in range(NUM_ELEMENTS):
    elements_list.append(ProbeElement(
        element_id=f"el_{i}", label=f"E{i}", color="blue",
        frequency=5.0, phase_shift=0.0, time_delay=0.0,
        intensity=100.0, enabled=True, apodization_weight=1.0
    ))

config = ArrayConfig(
    elements=elements_list,
    steering_angle=0.0,
    focus_depth=0.0,
    element_spacing=0.15, # <--- CHANGED TO 0.15 to fix B-Mode visual artifacts (Grating Lobes)
    geometry='linear',
    curvature_radius=0.0,
    num_elements=NUM_ELEMENTS,
    snr=40.0,
    apodization_window='hamming'
)
config.apply_apodization()

# --- 2. Init Environment ---
np.random.seed(42)
SCAN_DEPTH = 30.0
scatterers = []

# Static Tissue
for _ in range(150):
    scatterers.append(Scatterer(x=np.random.uniform(-20, 20), z=np.random.uniform(5, SCAN_DEPTH), reflectivity=np.random.uniform(0.5, 1.0)))

# Moving Blood Cells
VESSEL_START = (-15.0, 15.0)
VESSEL_DIRECTION = (1.0, 0.4)
VESSEL_RADIUS = 3.0
BLOOD_VELOCITY = 200.0 # mm/s

dir_x, dir_z = VESSEL_DIRECTION
norm = np.hypot(dir_x, dir_z)
dir_x, dir_z = dir_x/norm, dir_z/norm
perp_x, perp_z = -dir_z, dir_x

for _ in range(250):
    length_off = np.random.uniform(0, 40)
    radial_off = np.random.uniform(-VESSEL_RADIUS, VESSEL_RADIUS)
    x = VESSEL_START[0] + (dir_x * length_off) + (perp_x * radial_off)
    z = VESSEL_START[1] + (dir_z * length_off) + (perp_z * radial_off)

    flow = 1.0 - (radial_off / VESSEL_RADIUS)**2
    v_mag = BLOOD_VELOCITY * flow
    scatterers.append(MovingScatterer(x=x, z=z, reflectivity=np.random.uniform(0.05, 0.2), vx=dir_x * v_mag, vz=dir_z * v_mag))

env = DynamicEnvironment(scatterers=scatterers, background_noise_level=0.02)

# --- 3. Run Scenario ---
engine = PulseEchoEngine(config, env)
scenario = UltrasoundScenario(config, env, engine)

PRF = 4000.0
# Change angles to +/- 45 degrees to see the whole vessel
b_mode = scenario.generate_b_mode(start_angle=-45.0, end_angle=45.0, num_lines=48, max_depth_mm=SCAN_DEPTH)
color = scenario.generate_color_doppler(start_angle=-45.0, end_angle=45.0, num_lines=48, max_depth_mm=SCAN_DEPTH, prf_hz=PRF, packet_size=8)

# --- 4. Plotting ---
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 6))

# ---------------------------------------------------------
# NEW: Calculate Probe Element Positions (Centered at Z=0)
# ---------------------------------------------------------
total_array_width = (config.num_elements - 1) * config.element_spacing
probe_x = np.linspace(-total_array_width/2, total_array_width/2, config.num_elements)
probe_z = np.zeros_like(probe_x) # Elements sit at depth = 0

# --- Plot 1: Ground Truth Environment ---
t_x = [s.x for s in env.scatterers if not isinstance(s, MovingScatterer)]
t_z = [s.z for s in env.scatterers if not isinstance(s, MovingScatterer)]
b_x = [s.x for s in env.scatterers if isinstance(s, MovingScatterer)]
b_z = [s.z for s in env.scatterers if isinstance(s, MovingScatterer)]

ax1.scatter(t_x, t_z, color='gray', s=10, label='Tissue')
ax1.scatter(b_x, b_z, color='red', s=10, label='Blood')

# Plot Probe on Ground Truth
ax1.scatter(probe_x, probe_z, color='green', marker='s', s=30, label='Probe Elements', zorder=5)

ax1.set_xlim(-20, 20); ax1.set_ylim(0, SCAN_DEPTH)
ax1.invert_yaxis()
ax1.set_title("Ground Truth Physics Environment")
ax1.set_xlabel("Lateral (mm)"); ax1.set_ylabel("Depth (mm)")
ax1.legend(loc="upper right")

# --- Plot 2: Simulated Duplex Image ---
angles_rad = np.deg2rad(b_mode.sector_angles_deg)
depths = np.array(b_mode.axial_depths_mm)
THETA, R = np.meshgrid(angles_rad, depths)
X_grid = R * np.sin(THETA)
Z_grid = R * np.cos(THETA)

b_mode_img = np.array(b_mode.image_grid).T
vel_img = np.array(color.velocity_grid).T
power_img = np.array(color.power_grid).T

# Draw B-Mode
ax2.pcolormesh(X_grid, Z_grid, b_mode_img, cmap='gray', shading='auto', vmin=0, vmax=50)

# Doppler Power Threshold Logic
power_threshold = 4.0 # Lowered slightly to catch slower boundary cells
masked_vel = np.ma.masked_where(power_img < power_threshold, vel_img)
f0_hz = config.elements[0].frequency * 1e6
nyquist_ms = (config.wave_speed * 1000 * PRF) / (4 * f0_hz)

# Draw Color Doppler
doppler_plot = ax2.pcolormesh(X_grid, Z_grid, masked_vel, cmap='coolwarm', shading='auto', vmin=-nyquist_ms, vmax=nyquist_ms)

# Plot Probe on Duplex Image
ax2.scatter(probe_x, probe_z, color='green', marker='s', s=30, label='Probe Elements', zorder=5)

ax2.set_xlim(-20, 20); ax2.set_ylim(0, SCAN_DEPTH)
ax2.invert_yaxis()
ax2.set_title("Simulated Duplex (B-Mode + Color Doppler)")
ax2.set_xlabel("Lateral (mm)"); ax2.set_ylabel("Depth (mm)")
plt.colorbar(doppler_plot, ax=ax2, label="Velocity (m/s) [Blue=Away, Red=Towards]")

plt.tight_layout()
plt.show()