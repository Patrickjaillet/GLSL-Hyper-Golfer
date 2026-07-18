void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    float x = 1.0;
    x = 2.0;
    x = 3.0;

    float y = 1.0;
    y = 2.0;

    float z = 1.0;
    z = z;

    float w = 1.0;
    w += 2.0;

    for (int i = 0; i < 9; i++)
    {
        w += 1.0;
    }

    float a = 1.0;
    float b = 2.0;
    a = 3.0;

    float p = 1.0;
    float q = p;
    p = 3.0;

    fragColor = vec4(x, y + z, w, a + b + q + p);
}
