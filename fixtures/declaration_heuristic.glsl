struct Foo
{
    float x;
};

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    Foo a;
    a.x = 1.0;

    float z = 1.0;
    if (z > 0.0)
    {
        z = 2.0;
    }
    else
    {
        z = 3.0;
    }

    fragColor = vec4(a.x + z, 0.0, 0.0, 1.0);
}
