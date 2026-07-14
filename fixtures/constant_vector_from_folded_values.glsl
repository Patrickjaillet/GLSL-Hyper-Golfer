void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec3 a = vec3(2.0 + 1.0, 2.0 + 1.0, 2.0 + 1.0);
    vec4 b = vec4(1000000.0 + 0.0, 1000000.0, 1000000.0, 1000000.0);
    vec2 c = vec2(0.00005 + 0.00005, 0.0001);

    fragColor = vec4(a.x + b.x + c.x);
}
