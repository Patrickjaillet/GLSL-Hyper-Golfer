void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    float x = (1.0);
    float y = ((2.0));
    float a = (x + y);
    float b = (x + y) * 2.0;
    vec3 c = vec3((x));
    float d = 5.0 - (-x);
    float e = 5.0 + (+x);
    float f = 5.0 * (-x);

    if ((x > 0.0))
    {
        x = 1.0;
    }

    for (int i = 0; i < (4); i++)
    {
        y += x;
    }

    fragColor = vec4(x + y + a + b + c.x + d + e + f, 0.0, 0.0, 1.0);
}
