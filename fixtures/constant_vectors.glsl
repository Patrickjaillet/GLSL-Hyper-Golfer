vec3 solidRed() {
    vec3 red = vec3(1.0, 0.0, 0.0);
    vec3 white = vec3(1.0, 1.0, 1.0);
    vec4 background = vec4(0.5, 0.5, 0.5, 1.0);
    vec2 uv = vec2(1.0, 2.0);
    return red + white * background.rgb + vec3(uv, 0.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec3 c = solidRed();
    vec3 folded = vec3(2 * 3, 2 * 3, 2 * 3);
    fragColor = vec4(c + folded, 1.0);
}
