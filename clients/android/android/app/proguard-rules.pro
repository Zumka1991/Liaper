# R8 в релизе вырезал методы плагинов, вызываемые через Pigeon/JNI
# (shared_preferences: NoSuchMethodError getAll). Классы плагинов Flutter не трогаем.
-keep class io.flutter.plugins.** { *; }
-keep class io.flutter.plugin.** { *; }
-keep class io.flutter.embedding.** { *; }
-keep class com.liaper.** { *; }

# Flutter ссылается на Play Core (deferred components), которого в проекте нет
-dontwarn com.google.android.play.core.**
