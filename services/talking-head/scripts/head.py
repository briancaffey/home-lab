"""Build a stock MakeHuman head in Blender, key ARKit curves onto it, render and export.

Usage (inside Blender):  blender -b --python head.py -- <run_dir> <downloads_dir>
Reads   <run_dir>/curves.json (52 ARKit weights per frame) and <run_dir>/speech.wav
Writes  <run_dir>/head.mp4, head.glb, head.blend, still.png
"""
import glob
import json
import os
import sys
import zipfile

import bpy
from mathutils import Vector

run_dir, downloads = sys.argv[sys.argv.index("--") + 1:][:2]
WIDTH = int(os.environ.get("RENDER_SIZE", "720"))
SAMPLES = int(os.environ.get("RENDER_SAMPLES", "48"))

# --- MPFB2 add-on + CC0 asset packs -----------------------------------------
bpy.ops.preferences.addon_enable(module="bl_ext.user_default.mpfb")
from bl_ext.user_default.mpfb.services.exportservice import ExportService  # noqa: E402
from bl_ext.user_default.mpfb.services.faceservice import ARKIT_FACEUNITS, FaceService  # noqa: E402
from bl_ext.user_default.mpfb.services.humanservice import HumanService  # noqa: E402
from bl_ext.user_default.mpfb.services.locationservice import LocationService  # noqa: E402
from bl_ext.user_default.mpfb.services.targetservice import TargetService  # noqa: E402

data_dir = LocationService.get_user_data()
for pack in ("makehuman_system_assets_cc0.zip", "faceunits01.zip"):
    marker = os.path.join(data_dir, "." + pack + ".installed")
    if not os.path.exists(marker):
        zipfile.ZipFile(os.path.join(downloads, pack)).extractall(data_dir)
        open(marker, "w").close()
print("MPFB user data:", data_dir, sorted(os.listdir(data_dir)))


def asset(subdir, ext, *preferred):
    """First asset under <data>/<subdir> whose file name contains a preferred word."""
    found = sorted(glob.glob(os.path.join(data_dir, subdir, "**", "*." + ext), recursive=True))
    for word in preferred:
        for path in found:
            if word in os.path.basename(path).lower():
                return path
    return found[0] if found else None


# --- the character -----------------------------------------------------------
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

basemesh = HumanService.create_human()
basemesh.name = "Head"
skin = asset("skins", "mhmat", "young_caucasian_male", "caucasian")
if skin:
    HumanService.set_character_skin(skin, basemesh)
parts = [("eyes", ("high-poly", "low-poly")), ("eyebrows", ("eyebrow001",)), ("eyelashes", ("eyelashes01",)),
         ("teeth", ("teeth_base", "teeth")), ("tongue", ("tongue01", "tongue")), ("hair", ("short02", "short"))]
for subdir, preferred in parts:
    path = asset(subdir, "mhclo", *preferred)
    print("asset", subdir, "->", path)
    if path:
        try:
            HumanService.add_mhclo_asset(path, basemesh, asset_type=subdir.capitalize(), set_up_rigging=False)
        except Exception as exc:  # a missing nicety should not sink the run
            print("WARNING: could not add", subdir, exc)

# Same order as MPFB's "create export copy": bake body shape, load the 52 ARKit
# face units, copy them onto eyes/teeth/tongue/etc, then drop helper geometry.
TargetService.bake_targets(basemesh)
FaceService.load_targets(basemesh, load_microsoft_visemes=False, load_meta_visemes=False, load_arkit_faceunits=True)
FaceService.interpolate_targets(basemesh)
ExportService.bake_modifiers_remove_helpers(basemesh, bake_masks=True, bake_subdiv=False, remove_helpers=True, also_proxy=True)

meshes = [o for o in bpy.data.objects if o.type == "MESH" and o.data.shape_keys]
print("meshes with shape keys:", {o.name: len(o.data.shape_keys.key_blocks) - 1 for o in meshes})

# --- animation ---------------------------------------------------------------
curves = json.load(open(os.path.join(run_dir, "curves.json")))
names, frames = curves["names"], curves["frames"]
fps = int(round(curves["metadata"]["fps"]))
scene = bpy.context.scene
scene.render.fps = fps
scene.frame_start, scene.frame_end = 1, len(frames)
missing = [n for n in names if n not in ARKIT_FACEUNITS]
print("frames:", len(frames), "fps:", fps, "| curve names MPFB does not know:", missing)

for obj in meshes:
    keys = obj.data.shape_keys.key_blocks
    for column, name in enumerate(names):
        block = keys.get(name)
        if block is None:
            continue
        block.slider_max = 1.0
        for index, frame in enumerate(frames):
            block.value = max(0.0, min(1.0, frame["weights"][column]))
            block.keyframe_insert("value", frame=index + 1)

if not scene.sequence_editor:
    scene.sequence_editor_create()
scene.sequence_editor.sequences.new_sound("speech", os.path.join(run_dir, "speech.wav"), channel=1, frame_start=1)

# --- camera, light, render ---------------------------------------------------
bpy.context.view_layer.update()
top = max((basemesh.matrix_world @ Vector(c)).z for c in basemesh.bound_box)
face = Vector((0.0, 0.0, top - 0.13))           # roughly nose height on the 1.7 m default human
cam_data = bpy.data.cameras.new("Camera")
cam_data.lens = 85
cam = bpy.data.objects.new("Camera", cam_data)
scene.collection.objects.link(cam)
cam.location = face + Vector((0.08, -0.82, 0.0))
cam.rotation_euler = (face - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.camera = cam

for name, offset, energy, size in (("Key", (0.9, -1.2, 0.5), 90, 1.2), ("Fill", (-1.1, -0.9, 0.1), 25, 1.5), ("Rim", (0.2, 1.2, 0.6), 120, 0.8)):
    light_data = bpy.data.lights.new(name, "AREA")
    light_data.energy, light_data.size = energy, size
    light = bpy.data.objects.new(name, light_data)
    scene.collection.objects.link(light)
    light.location = face + Vector(offset)
    light.rotation_euler = (face - light.location).to_track_quat("-Z", "Y").to_euler()

world = bpy.data.worlds.new("World")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.045, 0.05, 0.06, 1.0)
scene.world = world

scene.render.engine = "CYCLES"
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
prefs = bpy.context.preferences.addons["cycles"].preferences
device = "CPU"
for backend in ("OPTIX", "CUDA"):
    try:
        prefs.compute_device_type = backend
        prefs.get_devices()
        gpus = [d for d in prefs.devices if d.type == backend]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == backend
            device = "GPU"
            print("Cycles device:", backend, [d.name for d in gpus])
            break
    except Exception as exc:
        print("no", backend, exc)
scene.cycles.device = device
print("rendering on", device)

scene.render.resolution_x = scene.render.resolution_y = WIDTH
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = "Filmic" if "Filmic" in [i.identifier for i in type(scene.view_settings).bl_rna.properties["view_transform"].enum_items] else scene.view_settings.view_transform

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(run_dir, "head.blend"))

# one still from the middle first: cheap to look at if the video goes wrong
scene.frame_set(max(1, len(frames) // 2))
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = os.path.join(run_dir, "still.png")
bpy.ops.render.render(write_still=True)

scene.render.image_settings.file_format = "FFMPEG"
scene.render.ffmpeg.format = "MPEG4"
scene.render.ffmpeg.codec = "H264"
scene.render.ffmpeg.constant_rate_factor = "MEDIUM"
scene.render.ffmpeg.audio_codec = "AAC"
scene.render.ffmpeg.audio_bitrate = 128
scene.render.filepath = os.path.join(run_dir, "head.mp4")
bpy.ops.render.render(animation=True)

bpy.ops.export_scene.gltf(filepath=os.path.join(run_dir, "head.glb"), export_format="GLB",
                          export_animations=True, export_morph=True, export_cameras=False, export_lights=False)
print("wrote", sorted(os.listdir(run_dir)))
