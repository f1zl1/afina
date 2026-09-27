import io
from pathlib import Path
from typing import BinaryIO

import torch
from PIL import Image
from ultralytics import YOLO


class CaptchaSolver:
    """
    Persistent YOLO inference service.

    The YOLO model is loaded once when this class is created and remains
    in memory for all subsequent solve_image(...) calls.
    """

    def __init__(
        self,
        model_path: str | Path,
        image_size: int = 640,
        confidence: float = 0.25,
        duplicate_iou_threshold: float = 0.5,
    ):
        self.model_path = Path(model_path)
        self.image_size = image_size
        self.confidence = confidence
        self.duplicate_iou_threshold = duplicate_iou_threshold

        if not self.model_path.is_file():
            raise FileNotFoundError(
                f"YOLO model not found: {self.model_path}"
            )

        self.device = 0 if torch.cuda.is_available() else "cpu"

        # Loaded once and kept in memory.
        self.model = YOLO(str(self.model_path))

    @staticmethod
    def _open_image(
        source: Image.Image
        | bytes
        | bytearray
        | memoryview
        | str
        | Path
        | BinaryIO,
    ) -> Image.Image:
        """
        Accepts:
        - PIL.Image
        - bytes / bytearray / memoryview
        - file path
        - file-like object
        """
        if isinstance(source, Image.Image):
            return source.convert("RGB")

        if isinstance(source, (bytes, bytearray, memoryview)):
            with Image.open(io.BytesIO(bytes(source))) as image:
                return image.convert("RGB")

        if isinstance(source, (str, Path)):
            with Image.open(source) as image:
                return image.convert("RGB")

        if hasattr(source, "read"):
            with Image.open(source) as image:
                return image.convert("RGB")

        raise TypeError(
            "source must be a PIL.Image, bytes, file-like object, or file path"
        )

    @staticmethod
    def _iou(box1, box2) -> float:
        x1 = max(float(box1[0]), float(box2[0]))
        y1 = max(float(box1[1]), float(box2[1]))
        x2 = min(float(box1[2]), float(box2[2]))
        y2 = min(float(box1[3]), float(box2[3]))

        intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)

        area1 = max(0.0, float(box1[2] - box1[0])) * max(
            0.0, float(box1[3] - box1[1])
        )
        area2 = max(0.0, float(box2[2] - box2[0])) * max(
            0.0, float(box2[3] - box2[1])
        )

        union = area1 + area2 - intersection
        return intersection / union if union > 0 else 0.0

    def _remove_duplicates(self, detections: list[dict]) -> list[dict]:
        """
        Removes overlapping detections of the same class and keeps
        the detection with the highest confidence.
        """
        detections = sorted(
            detections,
            key=lambda item: item["confidence"],
            reverse=True,
        )

        filtered = []

        for detection in detections:
            is_duplicate = False

            for kept in filtered:
                if detection["class_id"] != kept["class_id"]:
                    continue

                if (
                    self._iou(detection["box"], kept["box"])
                    > self.duplicate_iou_threshold
                ):
                    is_duplicate = True
                    break

            if not is_duplicate:
                filtered.append(detection)

        return filtered

    def solve_image(
        self,
        source: Image.Image
        | bytes
        | bytearray
        | memoryview
        | str
        | Path
        | BinaryIO,
    ) -> dict:

        try:
            image = self._open_image(source)

            results = self.model.predict(
                source=image,
                imgsz=self.image_size,
                conf=self.confidence,
                device=self.device,
                verbose=False,
            )

            boxes = results[0].boxes

            if boxes is None or len(boxes) == 0:
                return {
                    "captcha": None,
                    "error": "no detections",
                    "detections": [],
                }

            xyxy = boxes.xyxy.detach().cpu().tolist()
            classes = boxes.cls.detach().cpu().tolist()
            confidences = boxes.conf.detach().cpu().tolist()

            detections = [
                {
                    "box": box,
                    "class_id": int(class_id),
                    "confidence": float(confidence),
                }
                for box, class_id, confidence in zip(
                    xyxy,
                    classes,
                    confidences,
                )
            ]

            detections = self._remove_duplicates(detections)
            detections.sort(key=lambda item: item["box"][0])

            captcha = "".join(
                str(item["class_id"])
                for item in detections
            )

            return {
                "captcha": captcha or None,
                "error": None if captcha else "no valid detections",
                "detections": detections,
            }

        except Exception as error:
            return {
                "captcha": None,
                "error": str(error),
                "detections": [],
            }


# ---------------------------------------------------------------------------
# Singleton instance.
# Importing this module loads YOLO once and keeps it in RAM / VRAM.
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent

solver = CaptchaSolver(
    model_path=BASE_DIR / "best.pt",
)


def solve_image(source) -> dict:
    """
    Project-friendly wrapper.

    Example:
        from captchaSolver_yolo import solve_image

        result = solve_image(image_bytes)
        print(result["captcha"])
    """
    return solver.solve_image(source)


if __name__ == "__main__":
    import sys
    import json
    import base64

    print(
        json.dumps({
            "type": "ready"
        }),
        flush=True
    )

    for line in sys.stdin:
        line = line.strip()

        if not line:
            continue

        request = None

        try:
            request = json.loads(line)

            request_id = request.get("id")

            image_bytes = base64.b64decode(
                request["image"]
            )

            result = solve_image(
                image_bytes
            )

            print(
                json.dumps({
                    "id": request_id,
                    "result": result
                }),
                flush=True
            )

        except Exception as error:
            print(
                json.dumps({
                    "id": (
                        request.get("id")
                        if isinstance(request, dict)
                        else None
                    ),
                    "error": str(error)
                }),
                flush=True
            )