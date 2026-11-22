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
WIDTH = int(os.environ.get("RENDER_WIDTH", "720"))
HEIGHT = int(os.environ.get("RENDER_HEIGHT", "1280"))    # 9:16, the shape social video wants
STILL_ONLY = os.environ.get("STILL_ONLY", "") == "1"
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
    for match in (str.startswith, str.__contains__):          # "male_..." must not pick "female_..."
        for word in preferred:
            for path in found:
                if match(os.path.basename(path).lower(), word):
                    return path
    return found[0] if found else None


# --- the character -----------------------------------------------------------
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

macros = TargetService.get_default_macro_info_dict()
macros["gender"] = 1.0                      # the default is halfway; match the male skin and clothes
basemesh = HumanService.create_human(macro_detail_dict=macros)
basemesh.name = "Head"
skin = asset("skins", "mhmat", "young_caucasian_male", "caucasian")
if skin:
    HumanService.set_character_skin(skin, basemesh)
parts = [("eyes", ("high-poly", "low-poly")), ("eyebrows", ("eyebrow001",)), ("eyelashes", ("eyelashes01",)),
         ("teeth", ("teeth_base", "teeth")), ("tongue", ("tongue01", "tongue")), ("hair", ("short02", "short")),
         ("clothes", ("male_casualsuit01", "casualsuit"))]
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

# --- set, camera, light ------------------------------------------------------
import random  # noqa: E402

random.seed(7)
bpy.context.view_layer.update()
top = max((basemesh.matrix_world @ Vector(c)).z for c in basemesh.bound_box)
face = Vector((0.0, 0.0, top - 0.13))           # roughly nose height on the default human


def material(name, color, roughness=0.6, emission=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*color, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission
    return mat


def box(name, center, size, mat):
    bpy.ops.mesh.primitive_cube_add(location=center)
    obj = bpy.context.active_object
    obj.name, obj.scale = name, (size[0] / 2, size[1] / 2, size[2] / 2)
    obj.data.materials.append(mat)
    return obj


# A small study: wooden floor, two walls, a bookshelf, a framed picture and a lamp.
# It sits behind the character and is thrown out of focus, so simple shapes are enough.
wall = material("Wall", (0.20, 0.27, 0.26), 0.9)
wood = material("Wood", (0.20, 0.11, 0.06), 0.45)
box("Floor", (0, 1.0, -0.01), (8, 8, 0.02), material("Floor", (0.25, 0.16, 0.10), 0.5))
box("BackWall", (0, 2.6, 1.5), (8, 0.1, 3.2), wall)
box("SideWall", (-2.6, 0.5, 1.5), (0.1, 8, 3.2), wall)
book_tints = [(0.45, 0.12, 0.10), (0.10, 0.22, 0.38), (0.55, 0.42, 0.18), (0.14, 0.30, 0.20), (0.6, 0.57, 0.5)]
book_mats = [material("Book%d" % i, tint, 0.7) for i, tint in enumerate(book_tints)]
for shelf in range(6):                                         # bookshelf, back right
    z = 0.35 + shelf * 0.36
    box("Shelf%d" % shelf, (0.30, 2.35, z), (1.3, 0.32, 0.03), wood)
    x = -0.27
    while x < 0.85 and shelf < 5:
        w, h = random.uniform(0.025, 0.06), random.uniform(0.20, 0.30)
        box("Book", (x + w / 2, 2.33, z + 0.015 + h / 2), (w, 0.2, h), random.choice(book_mats))
        x += w + random.uniform(0.002, 0.012)
for x in (-0.35, 0.95):
    box("ShelfSide", (x, 2.35, 1.1), (0.03, 0.32, 2.2), wood)
box("Frame", (-1.45, 2.53, face.z + 0.1), (0.7, 0.04, 0.5), wood)
box("Picture", (-1.45, 2.50, face.z + 0.1), (0.6, 0.02, 0.4), material("Picture", (0.75, 0.55, 0.30), 0.8))
box("LampPole", (-0.62, 2.0, 0.75), (0.03, 0.03, 1.5), material("Metal", (0.05, 0.05, 0.05), 0.3))
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.13, location=(-0.62, 2.0, 1.58))
bpy.context.active_object.data.materials.append(material("LampGlow", (1.0, 0.62, 0.30), 0.5, emission=4.0))


def area_light(name, location, energy, size, color):
    data = bpy.data.lights.new(name, "AREA")
    data.energy, data.size, data.color = energy, size, color
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (face - Vector(location)).to_track_quat("-Z", "Y").to_euler()
    return obj


# Warm soft key from camera left (a window), a weak cool fill, a rim to lift the
# hair off the wall, and a warm lamp glow on the room itself.
area_light("Key", face + Vector((-1.1, -1.0, 0.45)), 40, 1.6, (1.0, 0.86, 0.72))
area_light("Fill", face + Vector((1.2, -0.9, 0.0)), 9, 1.5, (0.75, 0.85, 1.0))
area_light("Rim", face + Vector((0.9, 1.0, 0.55)), 45, 0.6, (0.85, 0.92, 1.0))
room = bpy.data.lights.new("RoomLamp", "POINT")
room.energy, room.color, room.shadow_soft_size = 90, (1.0, 0.7, 0.42), 0.2
room_obj = bpy.data.objects.new("RoomLamp", room)
scene.collection.objects.link(room_obj)
room_obj.location = (-0.5, 1.6, 1.8)

world = bpy.data.worlds.new("World")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.012, 0.014, 0.018, 1.0)
scene.world = world

# Camera: 50 mm, shallow focus on the face, a slow push-in on a slight arc.
target = bpy.data.objects.new("FaceTarget", None)
scene.collection.objects.link(target)
target.location = face + Vector((0, 0, -0.035))
cam_data = bpy.data.cameras.new("Camera")
cam_data.lens = 50
cam_data.dof.use_dof, cam_data.dof.focus_object, cam_data.dof.aperture_fstop = True, target, 3.5
cam = bpy.data.objects.new("Camera", cam_data)
scene.collection.objects.link(cam)
track = cam.constraints.new("TRACK_TO")
track.target, track.track_axis, track.up_axis = target, "TRACK_NEGATIVE_Z", "UP_Y"
cam.location = face + Vector((0.16, -1.05, 0.02))
cam.keyframe_insert("location", frame=scene.frame_start)
cam.location = face + Vector((-0.02, -0.86, 0.0))
cam.keyframe_insert("location", frame=scene.frame_end)
for fcurve in cam.animation_data.action.fcurves:
    for point in fcurve.keyframe_points:
        point.interpolation = "SINE"
    noise = fcurve.modifiers.new("NOISE")                      # a little handheld drift
    noise.scale, noise.strength, noise.phase = 45, 0.006, random.uniform(0, 100)
scene.camera = cam

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

scene.render.resolution_x, scene.render.resolution_y = WIDTH, HEIGHT
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = "AgX"
try:
    scene.view_settings.look = "AgX - Medium High Contrast"
except TypeError:
    pass

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(run_dir, "head.blend"))

# one still from the middle first: cheap to look at if the video goes wrong
scene.frame_set(max(1, len(frames) // 2))
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = os.path.join(run_dir, "still.png")
bpy.ops.render.render(write_still=True)
if STILL_ONLY:
    print("still only: skipping the animation render and export")
    sys.exit(0)

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
