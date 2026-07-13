void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    float x = 0.0;
    if (x > 0.5)
    {
        x = 1.0;
    }

    if (x > 0.0)
    {
        if (x > 1.0)
        {
            x = 2.0;
        }
    }
    else
    {
        x = 3.0;
    }

    for (int i = 0; i < 4; i++)
    {
        x += 1.0;
    }

    int j = 0;
    while (j < 4)
    {
        x -= 1.0;
        j++;
    }

    do
    {
        x *= 2.0;
    }
    while (x < 100.0);

    if (x > 0.0)
    {
        if (x > 1.0)
            x = 4.0;
    }
    else
    {
        x = 5.0;
    }

    fragColor = vec4(x, x, x, 1.0);
}
